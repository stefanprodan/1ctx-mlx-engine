// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A log for one test: each event as the line it would write, without the
// time and the area, so a test matches on the level, message and fields.

import { format, type Log, type LogLevel } from "../../src/server/lib/log.ts";

const PREFIX = /^time=\S+ (level=\S+ msg=(?:"(?:[^"\\]|\\.)*"|\S+)) area=test/;

export function testLog(write: (line: string) => void = () => {}): Log {
  const event =
    (level: LogLevel): Log[LogLevel] =>
    (msg, fields) =>
      write(
        format(new Date(0), "test", level, msg, fields).replace(PREFIX, "$1"),
      );
  return { info: event("info"), warn: event("warn"), error: event("error") };
}
