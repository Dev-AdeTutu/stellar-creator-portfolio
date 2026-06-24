'use client';

// Renders a "Flag" button on any portfolio item.  When clicked, it opens a
// small inline form so the logged-in user can submit a reason.  The flag is
// posted to /api/reports.  In the mock layer the button just shows confirmation.

import { useState } from 'react';
import { Flag } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface FlagContentButtonProps {
  contentId: string;
  contentType: 'bounty' | 'profile' | 'message' | 'portfolio';
  contentTitle: string;
}

const REASONS = [
  'NSFW / inappropriate content',
  'Plagiarism / copyright infringement',
  'Spam or misleading information',
  'Harassment or hate speech',
  'Other',
] as const;

type Reason = typeof REASONS[number];

export function FlagContentButton({
  contentId,
  contentType,
  contentTitle,
}: FlagContentButtonProps) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Reason | ''>('');
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setSubmitting(true);
    try {
      await fetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentId, contentType, reason: selected }),
      });
    } catch {
      // Non-fatal — best effort
    } finally {
      setSubmitting(false);
      setSubmitted(true);
    }
  }

  if (submitted) {
    return (
      <span
        role="status"
        aria-live="polite"
        className="text-xs text-muted-foreground flex items-center gap-1"
      >
        <Flag size={12} aria-hidden="true" className="text-amber-500" />
        Flagged for review
      </span>
    );
  }

  if (!open) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 text-xs text-muted-foreground gap-1 hover:text-destructive"
        onClick={() => setOpen(true)}
        aria-label={`Flag content: ${contentTitle}`}
      >
        <Flag size={12} aria-hidden="true" />
        Flag
      </Button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      aria-label={`Flag "${contentTitle}" for moderation`}
      className="flex flex-col gap-2 p-3 border border-border rounded-lg bg-card text-sm max-w-xs"
    >
      <fieldset>
        <legend className="font-medium mb-1 text-foreground">Why are you flagging this?</legend>
        <div className="space-y-1">
          {REASONS.map((r) => (
            <label key={r} className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="flag-reason"
                value={r}
                checked={selected === r}
                onChange={() => setSelected(r)}
                className="accent-primary focus-visible:ring-2 focus-visible:ring-ring"
              />
              {r}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex gap-2">
        <Button type="submit" size="sm" className="h-7 text-xs" disabled={!selected || submitting}>
          Submit Flag
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
