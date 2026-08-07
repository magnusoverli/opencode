// Home Assistant accepts naive datetimes as its configured local time. MCP
// callers must provide an instant explicitly so requests and responses cannot
// silently use different time references.
const RFC3339_WITH_TIMEZONE = /^(?<year>\d{4})-(?<month>0[1-9]|1[0-2])-(?<day>0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,12})?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/;

function hasValidCalendarDate(match) {
  const year = Number(match.groups.year);
  const month = Number(match.groups.month);
  const day = Number(match.groups.day);
  if (year < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

export function requireTimezoneAwareTimestamp(value, field) {
  const match = typeof value === "string" ? RFC3339_WITH_TIMEZONE.exec(value) : null;
  if (!match || !hasValidCalendarDate(match)) {
    throw new Error(
      `${field} must be a timezone-aware RFC 3339 timestamp with Z or a UTC offset, ` +
      "for example 2026-08-07T04:00:00Z or 2026-08-07T04:00:00+02:00"
    );
  }
  return value;
}
