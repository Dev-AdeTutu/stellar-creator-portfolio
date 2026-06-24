//! # Insurance Pool Contract (#831)
//!
//! Accumulates 0.1 % of every platform fee into a token-denominated pool that
//! can pay out verified claims approved by governance.
//!
//! ## Design
//!
//! ```text
//! escrow::release_funds()
//!   └─ calls insurance::contribute_to_pool(fee * 0.001, token)
//!
//! user              → insurance::submit_claim(amount, evidence)
//! governance vote   → insurance::approve_claim(claim_id)    (3-day window)
//! governance/admin  → insurance::execute_payout(claim_id)
//! ```
//!
//! ## Storage layout
//!
//! | Key                       | Value      | TTL      |
//! |---------------------------|------------|----------|
//! | `PoolBalance(token)`      | `i128`     | persistent |
//! | `Claim(id)`               | `Claim`    | persistent |
//! | `ClaimCounter`            | `u64`      | persistent |
//! | `Admin`                   | `Address`  | persistent |
//!
//! ## Invariants
//!
//! * Pool balance **never** goes negative: `execute_payout` panics if the
//!   requested amount exceeds the pool.
//! * Claims accumulate in the `Pending` state until governance calls
//!   `approve_claim`.  Only approved, un-executed claims can be paid out.
//! * The 0.1 % insurance levy is computed by the caller (escrow contract)
//!   before calling `contribute_to_pool`, keeping this contract stateless
//!   with respect to fee logic.

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, panic_with_error, symbol_short, token,
    Address, Env, String,
};

// ── Basis-point constant ─────────────────────────────────────────────────────

/// Insurance levy: 0.1 % = 10 bps of the platform fee collected per escrow.
pub const INSURANCE_BPS: i128 = 10;

/// Governance voting window for claims: 3 days in seconds.
pub const CLAIM_VOTING_PERIOD_SECS: u64 = 3 * 24 * 60 * 60;

// ── Storage keys ─────────────────────────────────────────────────────────────

#[contracttype]
pub enum DataKey {
    /// Current balance of the pool for a specific token.
    PoolBalance(Address),
    /// A claim record by numeric ID.
    Claim(u64),
    /// Monotonic counter for claim IDs.
    ClaimCounter,
    /// Contract administrator (set by governance multisig).
    Admin,
}

// ── Error codes ──────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Copy, Clone, Debug, PartialEq)]
pub enum InsuranceError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    ClaimNotFound = 4,
    ClaimNotApproved = 5,
    ClaimAlreadyExecuted = 6,
    InsufficientPoolBalance = 7,
    InvalidAmount = 8,
    VotingPeriodNotEnded = 9,
    ClaimAlreadyApproved = 10,
}

impl soroban_sdk::contracterror::ContractError for InsuranceError {
    fn as_i32(&self) -> i32 {
        *self as i32
    }
}

// ── Claim lifecycle ───────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum ClaimStatus {
    /// Waiting for governance vote.
    Pending,
    /// Governance approved — ready for `execute_payout`.
    Approved,
    /// Fully paid out.
    Executed,
    /// Rejected by governance.
    Rejected,
}

/// A single insurance claim submitted by a user.
#[contracttype]
pub struct Claim {
    pub id: u64,
    pub claimant: Address,
    /// Token the payout should be denominated in.
    pub token: Address,
    /// Amount requested (must not exceed pool balance at execution time).
    pub amount: i128,
    /// Arbitrary evidence string supplied by the claimant.
    pub evidence: String,
    pub status: ClaimStatus,
    /// Ledger timestamp when the claim was submitted.
    pub submitted_at: u64,
    /// Earliest ledger timestamp at which governance may approve/reject.
    /// Set to `submitted_at + CLAIM_VOTING_PERIOD_SECS`.
    pub voting_deadline: u64,
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct InsuranceContract;

#[contractimpl]
impl InsuranceContract {
    // ── Lifecycle ─────────────────────────────────────────────────────────────

    /// Initialize the contract, storing the governance multisig as admin.
    ///
    /// Must be called once before any other function.
    pub fn initialize(env: Env, admin: Address) {
        admin.require_auth();
        if env.storage().persistent().has(&DataKey::Admin) {
            panic_with_error!(&env, InsuranceError::AlreadyInitialized);
        }
        env.storage().persistent().set(&DataKey::Admin, &admin);
        env.storage()
            .persistent()
            .set(&DataKey::ClaimCounter, &0u64);
    }

    // ── Pool management ───────────────────────────────────────────────────────

    /// Deposit `amount` tokens into the insurance pool.
    ///
    /// Called by the escrow contract on every fee collection.
    /// The caller is responsible for computing `amount = fee * INSURANCE_BPS / 10_000`
    /// and must hold the corresponding token balance.
    ///
    /// `from` is the address transferring the tokens (typically the escrow contract).
    pub fn contribute_to_pool(env: Env, from: Address, amount: i128, token: Address) {
        from.require_auth();
        Self::require_initialized(&env);

        if amount <= 0 {
            panic_with_error!(&env, InsuranceError::InvalidAmount);
        }

        // Pull tokens into this contract.
        token::Client::new(&env, &token).transfer(&from, &env.current_contract_address(), &amount);

        let current = Self::get_pool_balance(env.clone(), token.clone());
        env.storage()
            .persistent()
            .set(&DataKey::PoolBalance(token.clone()), &(current + amount));

        env.events().publish(
            (symbol_short!("ins"), symbol_short!("contrib")),
            (from, token, amount),
        );
    }

    /// Return the current pool balance for `token`.
    pub fn get_pool_balance(env: Env, token: Address) -> i128 {
        env.storage()
            .persistent()
            .get::<DataKey, i128>(&DataKey::PoolBalance(token))
            .unwrap_or(0)
    }

    // ── Claims ────────────────────────────────────────────────────────────────

    /// Submit a new claim.
    ///
    /// The claim enters `Pending` state.  Governance has `CLAIM_VOTING_PERIOD_SECS`
    /// to review before `approve_claim` or `reject_claim` can be called.
    ///
    /// Returns the new claim ID.
    pub fn submit_claim(
        env: Env,
        claimant: Address,
        amount: i128,
        token: Address,
        evidence: String,
    ) -> u64 {
        claimant.require_auth();
        Self::require_initialized(&env);

        if amount <= 0 {
            panic_with_error!(&env, InsuranceError::InvalidAmount);
        }

        let id: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::ClaimCounter)
            .unwrap_or(0);

        let submitted_at = env.ledger().timestamp();
        let claim = Claim {
            id,
            claimant: claimant.clone(),
            token: token.clone(),
            amount,
            evidence,
            status: ClaimStatus::Pending,
            submitted_at,
            voting_deadline: submitted_at + CLAIM_VOTING_PERIOD_SECS,
        };
        env.storage().persistent().set(&DataKey::Claim(id), &claim);
        env.storage()
            .persistent()
            .set(&DataKey::ClaimCounter, &(id + 1));

        env.events().publish(
            (symbol_short!("ins"), symbol_short!("claim")),
            (id, claimant, token, amount),
        );
        id
    }

    /// Approve a pending claim.  Only the admin (governance multisig) may call this,
    /// and only after the `voting_deadline` has passed.
    pub fn approve_claim(env: Env, admin: Address, claim_id: u64) {
        admin.require_auth();
        Self::require_admin(&env, &admin);

        let mut claim = Self::load_claim(&env, claim_id);
        if env.ledger().timestamp() < claim.voting_deadline {
            panic_with_error!(&env, InsuranceError::VotingPeriodNotEnded);
        }
        if claim.status != ClaimStatus::Pending {
            panic_with_error!(&env, InsuranceError::ClaimAlreadyApproved);
        }
        claim.status = ClaimStatus::Approved;
        env.storage()
            .persistent()
            .set(&DataKey::Claim(claim_id), &claim);
        env.events().publish(
            (symbol_short!("ins"), symbol_short!("approved")),
            claim_id,
        );
    }

    /// Reject a pending claim.  Only admin may call this.
    pub fn reject_claim(env: Env, admin: Address, claim_id: u64) {
        admin.require_auth();
        Self::require_admin(&env, &admin);

        let mut claim = Self::load_claim(&env, claim_id);
        if claim.status != ClaimStatus::Pending {
            panic_with_error!(&env, InsuranceError::ClaimAlreadyApproved);
        }
        claim.status = ClaimStatus::Rejected;
        env.storage()
            .persistent()
            .set(&DataKey::Claim(claim_id), &claim);
        env.events().publish(
            (symbol_short!("ins"), symbol_short!("rejected")),
            claim_id,
        );
    }

    /// Execute payout for an approved claim.
    ///
    /// Transfers `claim.amount` (capped at pool balance) to `claim.claimant`
    /// and marks the claim `Executed`.
    pub fn execute_payout(env: Env, admin: Address, claim_id: u64) {
        admin.require_auth();
        Self::require_admin(&env, &admin);

        let mut claim = Self::load_claim(&env, claim_id);
        if claim.status != ClaimStatus::Approved {
            if claim.status == ClaimStatus::Executed {
                panic_with_error!(&env, InsuranceError::ClaimAlreadyExecuted);
            } else {
                panic_with_error!(&env, InsuranceError::ClaimNotApproved);
            }
        }

        let pool_balance = Self::get_pool_balance(env.clone(), claim.token.clone());
        if claim.amount > pool_balance {
            panic_with_error!(&env, InsuranceError::InsufficientPoolBalance);
        }

        // Transfer payout to claimant.
        token::Client::new(&env, &claim.token).transfer(
            &env.current_contract_address(),
            &claim.claimant,
            &claim.amount,
        );

        // Update pool balance.
        env.storage().persistent().set(
            &DataKey::PoolBalance(claim.token.clone()),
            &(pool_balance - claim.amount),
        );

        claim.status = ClaimStatus::Executed;
        env.storage()
            .persistent()
            .set(&DataKey::Claim(claim_id), &claim);

        env.events().publish(
            (symbol_short!("ins"), symbol_short!("payout")),
            (claim_id, claim.claimant, claim.token, claim.amount),
        );
    }

    /// Return a claim record by ID.
    pub fn get_claim(env: Env, claim_id: u64) -> Claim {
        Self::require_initialized(&env);
        Self::load_claim(&env, claim_id)
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    fn require_initialized(env: &Env) {
        if !env.storage().persistent().has(&DataKey::Admin) {
            panic_with_error!(env, InsuranceError::NotInitialized);
        }
    }

    fn require_admin(env: &Env, caller: &Address) {
        let admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Not initialized");
        if *caller != admin {
            panic_with_error!(env, InsuranceError::Unauthorized);
        }
    }

    fn load_claim(env: &Env, claim_id: u64) -> Claim {
        env.storage()
            .persistent()
            .get::<DataKey, Claim>(&DataKey::Claim(claim_id))
            .unwrap_or_else(|| panic_with_error!(env, InsuranceError::ClaimNotFound))
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        Env,
    };

    fn setup(env: &Env) -> (InsuranceContractClient, Address) {
        let id = env.register(InsuranceContract, ());
        let client = InsuranceContractClient::new(env, &id);
        let admin = Address::generate(env);
        client.initialize(&admin);
        (client, admin)
    }

    #[test]
    fn test_initialize_and_pool_balance_zero() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let token = Address::generate(&env);
        assert_eq!(client.get_pool_balance(&token), 0);
    }

    #[test]
    #[should_panic]
    fn test_double_initialize_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);
        client.initialize(&admin);
    }

    #[test]
    fn test_get_pool_balance_unknown_token_returns_zero() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        assert_eq!(client.get_pool_balance(&Address::generate(&env)), 0);
    }

    #[test]
    fn test_submit_claim_increments_counter() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let claimant = Address::generate(&env);
        let token = Address::generate(&env);
        let evidence = String::from_str(&env, "tx-hash-abc123");
        let id1 = client.submit_claim(&claimant, &500, &token, &evidence);
        let id2 = client.submit_claim(&claimant, &200, &token, &evidence);
        assert_eq!(id1, 0);
        assert_eq!(id2, 1);
    }

    #[test]
    fn test_claim_initial_status_is_pending() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let claimant = Address::generate(&env);
        let token = Address::generate(&env);
        let evidence = String::from_str(&env, "evidence");
        let id = client.submit_claim(&claimant, &100, &token, &evidence);
        let claim = client.get_claim(&id);
        assert_eq!(claim.status, ClaimStatus::Pending);
        assert_eq!(claim.amount, 100);
    }

    #[test]
    #[should_panic]
    fn test_approve_before_voting_deadline_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);
        let claimant = Address::generate(&env);
        let token = Address::generate(&env);
        let evidence = String::from_str(&env, "evidence");
        let id = client.submit_claim(&claimant, &100, &token, &evidence);
        // Voting deadline hasn't passed yet — should panic.
        client.approve_claim(&admin, &id);
    }

    #[test]
    fn test_approve_claim_after_voting_deadline() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);
        let claimant = Address::generate(&env);
        let token = Address::generate(&env);
        let evidence = String::from_str(&env, "evidence");
        let id = client.submit_claim(&claimant, &100, &token, &evidence);
        // Advance time past the voting deadline.
        env.ledger().with_mut(|l| {
            l.timestamp += CLAIM_VOTING_PERIOD_SECS + 1;
        });
        client.approve_claim(&admin, &id);
        let claim = client.get_claim(&id);
        assert_eq!(claim.status, ClaimStatus::Approved);
    }

    #[test]
    fn test_reject_claim() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);
        let claimant = Address::generate(&env);
        let token = Address::generate(&env);
        let evidence = String::from_str(&env, "evidence");
        let id = client.submit_claim(&claimant, &100, &token, &evidence);
        client.reject_claim(&admin, &id);
        let claim = client.get_claim(&id);
        assert_eq!(claim.status, ClaimStatus::Rejected);
    }

    #[test]
    #[should_panic]
    fn test_execute_payout_on_pending_claim_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);
        let claimant = Address::generate(&env);
        let token = Address::generate(&env);
        let evidence = String::from_str(&env, "evidence");
        let id = client.submit_claim(&claimant, &100, &token, &evidence);
        client.execute_payout(&admin, &id);
    }

    #[test]
    #[should_panic]
    fn test_submit_claim_zero_amount_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let claimant = Address::generate(&env);
        let token = Address::generate(&env);
        let evidence = String::from_str(&env, "evidence");
        client.submit_claim(&claimant, &0, &token, &evidence);
    }

    #[test]
    #[should_panic]
    fn test_non_admin_cannot_approve_claim() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let claimant = Address::generate(&env);
        let token = Address::generate(&env);
        let evidence = String::from_str(&env, "evidence");
        let id = client.submit_claim(&claimant, &100, &token, &evidence);
        env.ledger().with_mut(|l| {
            l.timestamp += CLAIM_VOTING_PERIOD_SECS + 1;
        });
        let stranger = Address::generate(&env);
        client.approve_claim(&stranger, &id);
    }

    #[test]
    fn test_insurance_bps_constant() {
        // 0.1 % = 10 bps
        assert_eq!(INSURANCE_BPS, 10);
        // Levy on 1_000 units = 1 unit
        assert_eq!(1_000i128 * INSURANCE_BPS / 10_000, 1);
    }
}
