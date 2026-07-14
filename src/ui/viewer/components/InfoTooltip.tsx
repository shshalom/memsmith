// SPDX-License-Identifier: Apache-2.0
import React from 'react';

interface InfoTooltipProps {
  text?: string;
}

// Small ⓘ affordance: explains a setting on hover/focus. Renders nothing when
// there's no text (so callers can pass an optional description unconditionally).
// Reuses the existing `tooltip-trigger` CSS + native title attribute — no popover
// infra needed.
export function InfoTooltip({ text }: InfoTooltipProps): React.ReactElement | null {
  if (!text) return null;
  return (
    <span
      className="info-tooltip tooltip-trigger"
      role="img"
      aria-label={text}
      title={text}
      tabIndex={0}
    >
      ⓘ
    </span>
  );
}
