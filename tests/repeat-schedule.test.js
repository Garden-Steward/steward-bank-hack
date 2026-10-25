/**
 * When a recurring task is due (src/utils/repeat-schedule.js). Pure date
 * logic, so no Strapi boot. Instants are noon Pacific (19:00 UTC in PDT,
 * 20:00 UTC in PST) so each one lands squarely on its calendar day.
 */
const { isDueOn } = require('../src/utils/repeat-schedule');

// 2026-10-27 is a Tuesday.
const noonPacific = (ymd) => new Date(`${ymd}T${ymd < '2026-11-01' || ymd >= '2027-03-14' ? '19' : '20'}:00:00Z`);
const dueDays = (recTask, from, count) => {
  const out = [];
  const start = new Date(`${from}T12:00:00Z`);
  for (let i = 0; i < count; i++) {
    const day = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10);
    if (isDueOn(recTask, noonPacific(day))) out.push(day);
  }
  return out;
};

describe('repeat schedule: isDueOn', () => {
  it('a template with no frequency stays daily, as before repeats existed', () => {
    expect(dueDays({}, '2026-10-26', 7)).toHaveLength(7);
  });

  it('daily is every day', () => {
    expect(dueDays({ repeat_frequency: 'daily' }, '2026-10-26', 7)).toHaveLength(7);
  });

  it('weekly watering on Tuesday, Wednesday and Thursday', () => {
    const water = { repeat_frequency: 'weekly', repeat_days: ['Tuesday', 'Wednesday', 'Thursday'] };
    expect(dueDays(water, '2026-10-25', 14)).toEqual([
      '2026-10-27', '2026-10-28', '2026-10-29',
      '2026-11-03', '2026-11-04', '2026-11-05',
    ]);
  });

  it('weekly with no days is never due', () => {
    expect(dueDays({ repeat_frequency: 'weekly', repeat_days: [] }, '2026-10-25', 14)).toEqual([]);
  });

  it('biweekly counts weeks from the start date', () => {
    const task = { repeat_frequency: 'biweekly', repeat_days: ['Monday'], repeat_start: '2026-10-28' };
    expect(dueDays(task, '2026-10-25', 35)).toEqual(['2026-11-09', '2026-11-23']);
  });

  it('nothing is due before the start date', () => {
    const task = { repeat_frequency: 'weekly', repeat_days: ['Tuesday'], repeat_start: '2026-11-01' };
    expect(dueDays(task, '2026-10-25', 14)).toEqual(['2026-11-03']);
  });

  it("monthly repeats on the start date's day, clamped in short months", () => {
    const task = { repeat_frequency: 'monthly', repeat_start: '2027-01-31' };
    expect(dueDays(task, '2027-01-01', 120)).toEqual(['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']);
  });

  it('quarterly is every third month from the start', () => {
    const task = { repeat_frequency: 'quarterly', repeat_start: '2026-11-15' };
    expect(dueDays(task, '2026-11-01', 400)).toEqual(['2026-11-15', '2027-02-15', '2027-05-15', '2027-08-15', '2027-11-15']);
  });

  it('monthly or quarterly without a start date is never due', () => {
    expect(dueDays({ repeat_frequency: 'monthly' }, '2026-11-01', 60)).toEqual([]);
  });

  it('uses the Pacific calendar day, not UTC', () => {
    const tuesdays = { repeat_frequency: 'weekly', repeat_days: ['Tuesday'] };
    // 06:00 UTC Wednesday is still 11pm Tuesday in Seattle.
    expect(isDueOn(tuesdays, new Date('2026-10-28T06:00:00Z'))).toBe(true);
    expect(isDueOn(tuesdays, new Date('2026-10-28T08:00:00Z'))).toBe(false);
  });
});
