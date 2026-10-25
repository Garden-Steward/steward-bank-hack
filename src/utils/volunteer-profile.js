'use strict';

// Employers known to pay the garden for each hour an employee volunteers (checked 24 Oct 2026).
// The grant goes to the nonprofit, not the volunteer, once the hours are logged.
const EMPLOYER_GRANTS = [
  { match: /\bmicrosoft\b/i, employer: 'Microsoft', perHour: 25, via: 'Microsoft Give (Benevity)' },
  { match: /\bapple\b/i, employer: 'Apple', perHour: 25, via: 'Apple Employee Giving (Benevity)' },
];

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const TIMES = ['morning', 'afternoon', 'evening'];
const FREQUENCIES = ['weekly', 'monthly', 'occasionally'];

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const list = (value, max, length) => (Array.isArray(value) ? [...new Set(value.map((item) => text(item, length)).filter(Boolean))].slice(0, max) : []);

function employerGrant(employer) {
  const found = EMPLOYER_GRANTS.find((grant) => grant.match.test(employer || ''));
  return found ? { employer: found.employer, perHour: found.perHour, via: found.via } : null;
}

// Validates the volunteer-editable profile fields; returns { data, error }.
function cleanProfile(body) {
  const linkedinUrl = text(body.linkedinUrl, 300);
  if (linkedinUrl && !/^https:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9_-]{2,100}\/?$/.test(linkedinUrl)) {
    return { error: 'Use a LinkedIn profile link such as https://www.linkedin.com/in/your-name' };
  }
  const email = text(body.email, 200);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'Enter a valid email address.' };
  const frequency = FREQUENCIES.includes(body.frequency) ? body.frequency : null;
  const availability = {
    days: list(body.availability?.days, 7, 3).filter((day) => DAYS.includes(day)),
    times: list(body.availability?.times, 3, 9).filter((time) => TIMES.includes(time)),
  };
  const benefits = body.benefits || {};
  const hoursNeeded = Number.parseInt(benefits.schoolServiceHours?.hoursNeeded, 10);
  const employer = text(body.employer, 120);
  const volunteerBenefits = {
    schoolServiceHours: benefits.schoolServiceHours ? { hoursNeeded: Number.isFinite(hoursNeeded) && hoursNeeded > 0 && hoursNeeded <= 500 ? hoursNeeded : null, school: text(benefits.schoolServiceHours.school, 120) } : null,
    ffa: benefits.ffa === true,
    communityCollege: benefits.communityCollege === true,
    calfresh: benefits.calfresh === true,
    employerGrant: employerGrant(employer),
  };
  const data = {
    firstName: text(body.firstName, 60),
    lastName: text(body.lastName, 60),
    email,
    linkedinUrl: linkedinUrl || null,
    employer: employer || null,
    jobTitle: text(body.jobTitle, 120) || null,
    skills: list(body.skills, 12, 40),
    availability,
    frequency,
    volunteerBenefits,
    goals: text(body.goals, 600) || null,
    emailConsent: body.emailConsent === true,
  };
  return { data };
}

// Plain-language notes on what the volunteer's answers unlock, shown after joining.
function benefitNotes(benefits, gardenTitle) {
  const notes = [];
  if (benefits?.employerGrant) notes.push(`${benefits.employerGrant.employer} gives ${gardenTitle || 'the garden'} $${benefits.employerGrant.perHour} for every hour you volunteer. Log your hours in ${benefits.employerGrant.via}.`);
  if (benefits?.schoolServiceHours) notes.push(`We can sign off your service hours${benefits.schoolServiceHours.hoursNeeded ? ` toward your ${benefits.schoolServiceHours.hoursNeeded}` : ''}.`);
  if (benefits?.ffa) notes.push('Your garden shifts can count as FFA placement hours once your agriculture teacher approves.');
  if (benefits?.communityCollege) notes.push('Your hours here can count toward community-college work-experience credit.');
  if (benefits?.calfresh) notes.push('Your hours here can count toward the CalFresh work rule; a coordinator can sign the monthly form.');
  return notes;
}

module.exports = { EMPLOYER_GRANTS, employerGrant, cleanProfile, benefitNotes };
