// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

export class LockBusyError extends Error {
  constructor(readonly holder: string) {
    super(`${holder} is still running`);
  }
}

export class ExclusiveLock {
  private holder: string | null = null;

  running(): string | null {
    return this.holder;
  }

  async run<T>(label: string, operation: () => Promise<T>): Promise<T> {
    if (this.holder !== null) throw new LockBusyError(this.holder);
    this.holder = label;
    try {
      return await operation();
    } finally {
      this.holder = null;
    }
  }
}
