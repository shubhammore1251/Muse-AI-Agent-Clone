function parseDate(value?: string, fallback = new Date()) {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

export function getChatDateKey(value?: string): string {
  const date = parseDate(value);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function getChatDateLabel(value?: string, now = new Date()): string {
  const date = parseDate(value, now);
  const dateStart = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  );
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);

  if (dateStart.getTime() === todayStart.getTime()) return "Today";
  if (dateStart.getTime() === yesterdayStart.getTime()) return "Yesterday";

  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "2-digit",
    year: "numeric",
  });
}
