// SPDX-License-Identifier: Apache-2.0
import React from 'react';

interface InfoTooltipProps {
  text?: string;
}

// Small ⓘ affordance: explains a setting on hover/focus via a real CSS popover
// (the `.info-tooltip-text` child, revealed by `.info-tooltip:hover/:focus`).
// Renders nothing when there's no text, so callers can pass an optional
// description unconditionally. `aria-label` keeps it accessible; `tabIndex=0`
// makes the popover reachable by keyboard focus, not just mouse hover.
export function InfoTooltip({ text }: InfoTooltipProps): React.ReactElement | null {
  if (!text) return null;
  return (
    <span
      className="info-tooltip tooltip-trigger"
      role="img"
      aria-label={text}
      tabIndex={0}
    >
      ⓘ
      <span className="info-tooltip-text" role="tooltip">{text}</span>
    </span>
  );
}
