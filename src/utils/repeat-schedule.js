'use strict';

/**
 * When a recurring task is due. The daily createRecurringTasks cron asks this
 * before making the day's task, so "water every Tuesday, Wednesday and
 * Thursday" only shows up on those days.
 *
 * A recurring task carries:
 *   repeat_frequency  'daily' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly'
 *                     (null: a template from before repeats existed — still daily)
 *   repeat_days       weekday names, for weekly and biweekly: ['Tuesday', 'Wednesday']
 *   repeat_start      'YYYY-MM-DD'. Nothing is due before it. Biweekly counts
 *                     weeks from it; monthly and quarterly repeat on its day of
 *                     the month (the last day, in shorter months).
 *
 * Dates are the garden's calendar day in Pacific time, like the watering cutoff.
 */

const { utcToZonedTime } = require('date-fns-tz');

const PACIFIC_TZ = 'America/Los_Angeles';
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const FREQUENCIES = ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly'];

/** Pacific calendar date of an instant, as { y, m (0-11), d }. */
function pacificDay(now) {
  const z = utcToZonedTime(now, PACIFIC_TZ);
  return { y: z.getFullYear(), m: z.getMonth(), d: z.getDate() };
}

/** 'YYYY-MM-DD' (or a longer ISO string) → { y, m, d }, else null. */
function parseDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  return match ? { y: Number(match[1]), m: Number(match[2]) - 1, d: Number(match[3]) } : null;
}

const dayNumber = ({ y, m, d }) => Math.floor(Date.UTC(y, m, d) / 86400000);
const weekday = (day) => (dayNumber(day) + 4) % 7; // 1970-01-01 was a Thursday
const weekNumber = (day) => (dayNumber(day) - weekday(day)) / 7; // weeks start on Sunday
const daysInMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

function isDueOn(recTask, now = new Date()) {
  const today = pacificDay(now);
  const start = parseDay(recTask?.repeat_start);
  if (start && dayNumber(today) < dayNumber(start)) return false;

  const frequency = recTask?.repeat_frequency || 'daily';
  if (frequency === 'daily') return true;

  if (frequency === 'weekly' || frequency === 'biweekly') {
    const days = Array.isArray(recTask.repeat_days) ? recTask.repeat_days : [];
    if (!days.includes(WEEKDAYS[weekday(today)])) return false;
    // Without a start week there's nothing to count from, so every week it is.
    if (frequency === 'weekly' || !start) return true;
    return (weekNumber(today) - weekNumber(start)) % 2 === 0;
  }

  if (frequency === 'monthly' || frequency === 'quarterly') {
    if (!start) return false;
    const months = (today.y - start.y) * 12 + (today.m - start.m);
    if (months % (frequency === 'quarterly' ? 3 : 1) !== 0) return false;
    return today.d === Math.min(start.d, daysInMonth(today.y, today.m));
  }

  return false;
}

module.exports = { isDueOn, WEEKDAYS, FREQUENCIES, PACIFIC_TZ };
