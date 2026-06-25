/**
 * Load test: 50 concurrent bounty submissions without sequence collisions
 * Issue #838 acceptance criteria: 50 concurrent submissions succeed, >20 tx/s
 *
 * Run with k6:
 *   k6 run load-tests/sequence-collision.test.js -e BASE_URL=http://localhost:3000
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

// ── Custom metrics ────────────────────────────────────────────────────────────
const sequenceErrors  = new Rate('sequence_collision_errors');
const txSuccessRate   = new Rate('tx_success_rate');
const txLatency       = new Trend('tx_latency_ms', true);
const totalSubmitted  = new Counter('total_submitted');

// ── Test config ───────────────────────────────────────────────────────────────
export const options = {
  scenarios: {
    concurrent_bounty_submissions: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 50 }, // Ramp to 50 concurrent users
        { duration: '30s', target: 50 }, // Hold 50 concurrent for 30s
        { duration: '10s', target:  0 }, // Ramp down
      ],
    },
  },
  thresholds: {
    // No sequence collision errors allowed
    sequence_collision_errors: ['rate<0.01'],
    // 95% of tx succeed
    tx_success_rate: ['rate>0.95'],
    // p95 latency < 2 seconds
    tx_latency_ms: ['p(95)<2000'],
    // Overall http error rate < 1%
    http_req_failed: ['rate<0.01'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

// Shared test account (to maximise collision pressure)
const TEST_ACCOUNT = 'GDRAINTEST0000000000000000000000000000000000000000000000';

export default function () {
  const start = Date.now();

  const payload = JSON.stringify({
    accountId: TEST_ACCOUNT,
    contractId: 'CBOUNTY00000000000000000000000000000000000000000000000000',
    method:    'submit_bounty',
    args: {
      title:       `Bounty from VU ${__VU} iteration ${__ITER}`,
      budget:      1000,
      deadline:    new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    },
  });

  const res = http.post(
    `${BASE_URL}/api/soroban/enqueue`,
    payload,
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: '10s',
    },
  );

  const latencyMs = Date.now() - start;
  txLatency.add(latencyMs);
  totalSubmitted.add(1);

  const isSuccess = check(res, {
    'status is 200 or 201':  (r) => r.status === 200 || r.status === 201,
    'no sequence collision':  (r) => {
      const body = r.json();
      return !String(body?.error ?? '').includes('bad sequence') &&
             !String(body?.error ?? '').includes('txBAD_SEQ');
    },
    'has queue id': (r) => {
      const body = r.json();
      return !!body?.id || !!body?.queueId;
    },
  });

  const hasSeqError = String(res.json()?.error ?? '').includes('bad sequence');
  sequenceErrors.add(hasSeqError ? 1 : 0);
  txSuccessRate.add(isSuccess ? 1 : 0);

  // Brief pause to simulate realistic inter-request time
  sleep(Math.random() * 0.1);
}

export function handleSummary(data) {
  const submitted = data.metrics?.total_submitted?.values?.count ?? 0;
  const duration  = data.state?.testRunDurationMs ?? 1;
  const txPerSec  = ((submitted / duration) * 1000).toFixed(2);

  console.log(`\n=== Sequence Collision Load Test Summary ===`);
  console.log(`Total submitted:  ${submitted}`);
  console.log(`Duration:         ${(duration / 1000).toFixed(1)}s`);
  console.log(`Throughput:       ${txPerSec} tx/s`);
  console.log(`Collision errors: ${(data.metrics?.sequence_collision_errors?.values?.rate * 100).toFixed(2)}%`);
  console.log(`Success rate:     ${(data.metrics?.tx_success_rate?.values?.rate * 100).toFixed(2)}%`);

  const passes = parseFloat(txPerSec) >= 20;
  console.log(passes
    ? `✅ PASS: throughput ${txPerSec} tx/s >= 20 tx/s target`
    : `❌ FAIL: throughput ${txPerSec} tx/s < 20 tx/s target`,
  );

  return {
    'sequence-collision-results.json': JSON.stringify(data, null, 2),
  };
}
