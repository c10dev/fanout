// Run the tests as if it were later: SHIFT_DAYS=400 NODE_OPTIONS=--import=./scripts/shift-clock.mjs npm test
// Tests that hard-code a date "in the future" and compare it with the real clock break once that
// date passes; CI runs the suite a year ahead to catch them before the calendar does.

const offset = Number(process.env.SHIFT_DAYS ?? 400) * 86_400_000;
const RealDate = Date;

class ShiftedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(RealDate.now() + offset);
    else super(...args);
  }

  static now() {
    return RealDate.now() + offset;
  }
}

globalThis.Date = ShiftedDate;
