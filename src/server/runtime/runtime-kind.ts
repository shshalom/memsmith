// SPDX-License-Identifier: Apache-2.0
//
// Whether this process is the single-user local runtime. Set only by
// startLocalRuntime, never from configuration or a request, so nothing a
// caller sends can turn on behavior meant for one user's own machine.
let localRuntime = false;

export function markLocalRuntime(): void {
  localRuntime = true;
}

export function isLocalRuntime(): boolean {
  return localRuntime;
}
