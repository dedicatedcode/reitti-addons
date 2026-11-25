import { addDays, isDate, isTime, InputError } from "../util.js";

const MODES = new Set(["always", "range", "daily"]);

export function zonedNow(timeZone, date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hour = Number(values.hour) % 24;
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    minutes: hour * 60 + Number(values.minute),
  };
}

export function minutesOfDay(value) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

export function defaultValidity(timezone) {
  return {
    mode: "always",
    timezone,
    startDate: null,
    startTime: null,
    endDate: null,
    endTime: null,
    dailyStart: null,
    dailyEnd: null,
  };
}

export function normalizeValidity(input, fallbackTimezone) {
  const source = input == null ? {} : input;
  if (typeof source !== "object" || Array.isArray(source)) {
    throw new InputError("validity must be an object");
  }
  const mode = source.mode ?? "always";
  if (!MODES.has(mode)) throw new InputError("validity.mode must be always, range, or daily");

  const timezone = source.timezone ?? fallbackTimezone;
  if (typeof timezone !== "string" || !timezone.trim()) {
    throw new InputError("validity.timezone must be an IANA time zone");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date());
  } catch {
    throw new InputError(`validity.timezone is not a valid IANA time zone: ${timezone}`);
  }

  const validity = defaultValidity(timezone.trim());
  validity.mode = mode;

  if (mode === "always") return validity;

  if (mode === "range") {
    if (source.startDate != null && source.startDate !== "") {
      if (!isDate(source.startDate)) throw new InputError("validity.startDate must be YYYY-MM-DD");
      validity.startDate = source.startDate;
    }
    if (source.endDate != null && source.endDate !== "") {
      if (!isDate(source.endDate)) throw new InputError("validity.endDate must be YYYY-MM-DD");
      validity.endDate = source.endDate;
    }
    if (!validity.startDate && !validity.endDate) {
      throw new InputError("validity range needs a start date, an end date, or both");
    }
    const startTime = source.startTime || "00:00";
    const endTime = source.endTime || "23:59";
    if (!isTime(startTime)) throw new InputError("validity.startTime must be HH:MM");
    if (!isTime(endTime)) throw new InputError("validity.endTime must be HH:MM");
    validity.startTime = validity.startDate ? startTime : null;
    validity.endTime = validity.endDate ? endTime : null;
    if (
      validity.startDate &&
      validity.endDate &&
      (validity.startDate > validity.endDate ||
        (validity.startDate === validity.endDate &&
          minutesOfDay(validity.startTime) > minutesOfDay(validity.endTime)))
    ) {
      throw new InputError("validity start must not be after its end");
    }
    return validity;
  }

  if (!isTime(source.dailyStart) || !isTime(source.dailyEnd)) {
    throw new InputError("validity.dailyStart and validity.dailyEnd must be HH:MM");
  }
  validity.dailyStart = source.dailyStart;
  validity.dailyEnd = source.dailyEnd;
  if (source.startDate != null && source.startDate !== "") {
    if (!isDate(source.startDate)) throw new InputError("validity.startDate must be YYYY-MM-DD");
    validity.startDate = source.startDate;
  }
  if (source.endDate != null && source.endDate !== "") {
    if (!isDate(source.endDate)) throw new InputError("validity.endDate must be YYYY-MM-DD");
    validity.endDate = source.endDate;
  }
  if (validity.startDate && validity.endDate && validity.startDate > validity.endDate) {
    throw new InputError("validity start date must not be after its end date");
  }
  return validity;
}

function withinDateRange(validity, date) {
  if (validity.startDate && date < validity.startDate) return false;
  if (validity.endDate && date > validity.endDate) return false;
  return true;
}

function compareDateTime(dateA, minutesA, dateB, minutesB) {
  if (dateA !== dateB) return dateA < dateB ? -1 : 1;
  return minutesA === minutesB ? 0 : minutesA < minutesB ? -1 : 1;
}

function activeInRange(validity, now) {
  if (validity.startDate) {
    const startMinutes = minutesOfDay(validity.startTime || "00:00");
    if (compareDateTime(validity.startDate, startMinutes, now.date, now.minutes) > 0) return false;
  }
  if (validity.endDate) {
    const endMinutes = minutesOfDay(validity.endTime || "23:59");
    if (compareDateTime(validity.endDate, endMinutes, now.date, now.minutes) < 0) return false;
  }
  return true;
}

function overlapsRange(validity, date) {
  if (validity.startDate && date < validity.startDate) return false;
  if (validity.endDate && date > validity.endDate) return false;
  return true;
}

function activeInDailyWindow(validity, now) {
  const start = minutesOfDay(validity.dailyStart);
  const end = minutesOfDay(validity.dailyEnd);
  if (start === end) return withinDateRange(validity, now.date);
  if (start < end) {
    return (
      withinDateRange(validity, now.date) &&
      now.minutes >= start &&
      now.minutes <= end
    );
  }
  if (now.minutes >= start) {
    return withinDateRange(validity, now.date);
  }
  if (now.minutes <= end) {
    return withinDateRange(validity, addDays(now.date, -1));
  }
  return false;
}

/**
 * Returns true when the overlay is active for the requested map day.
 *
 * `date` is the day Reitti sent (browser-local). When it equals the current
 * day in the overlay's time zone the check is exact to the minute; any other
 * day only needs an overlap with the overlay's validity.
 */
export function isActive(validity, { now, date = null }) {
  if (!validity || validity.mode === "always") return true;
  const requested = date || null;
  const exact = requested == null || requested === now.date;

  if (validity.mode === "range") {
    return exact ? activeInRange(validity, now) : overlapsRange(validity, requested);
  }

  if (validity.mode === "daily") {
    if (exact) return activeInDailyWindow(validity, now);
    return withinDateRange(validity, requested);
  }

  return false;
}

export function describeValidity(validity) {
  if (!validity || validity.mode === "always") return "Always";
  if (validity.mode === "range") {
    const start = validity.startDate ? `${validity.startDate} ${validity.startTime}` : "open";
    const end = validity.endDate ? `${validity.endDate} ${validity.endTime}` : "open";
    return `${start} → ${end} (${validity.timezone})`;
  }
  const window = `${validity.dailyStart}–${validity.dailyEnd}`;
  if (validity.startDate || validity.endDate) {
    const from = validity.startDate || "open";
    const to = validity.endDate || "open";
    return `Daily ${window}, ${from} → ${to} (${validity.timezone})`;
  }
  return `Daily ${window} (${validity.timezone})`;
}
