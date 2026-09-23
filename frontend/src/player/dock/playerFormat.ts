export function formatTime(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0:00";
  const total = Math.floor(value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/** Remaining time in the iOS style, for example `-3:05`. */
export function formatRemaining(currentTime: number, duration: number) {
  if (!Number.isFinite(duration) || duration <= 0) return "-0:00";
  const safeCurrent = Number.isFinite(currentTime) ? Math.max(0, currentTime) : 0;
  return `-${formatTime(Math.ceil(Math.max(0, duration - safeCurrent)))}`;
}

export function formatScrubTime(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0:00.00";
  const totalHundredths = Math.round(value * 100);
  const hours = Math.floor(totalHundredths / 360000);
  const minutes = Math.floor((totalHundredths % 360000) / 6000);
  const seconds = Math.floor((totalHundredths % 6000) / 100);
  const hundredths = totalHundredths % 100;
  const secondText = `${seconds.toString().padStart(2, "0")}.${hundredths.toString().padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${minutes.toString().padStart(2, "0")}:${secondText}` : `${minutes}:${secondText}`;
}

export function formatSignedSeconds(value: number) {
  const normalized = Math.abs(value) < 0.005 ? 0 : value;
  return `${normalized >= 0 ? "+" : "-"}${Math.abs(normalized).toFixed(2)}s`;
}

export function formatSleepRemaining(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0m";
  if (seconds < 60) return "<1m";
  const minutes = Math.ceil(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60 ? `${minutes % 60}m` : ""}` : `${minutes}m`;
}

export function validSleepMinutes(value: string) {
  const minutes = Number(value);
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440;
}

/** Played share of the track as a 0-100 percentage; 0 while the duration is unknown. */
export function playbackProgressPercent(currentTime: number, duration: number) {
  return duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
}
