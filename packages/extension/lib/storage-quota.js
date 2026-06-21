/**
 * storage-quota.js — chrome.storage.local quota thresholds + pressure classifier.
 *
 * The extension persists capture data to chrome.storage.local (10 MiB quota for an
 * extension without `unlimitedStorage`). As usage approaches the quota the service
 * worker pauses capture and the side panel warns the user (#127); capture resumes
 * once usage drops back below a lower threshold. The lower resume threshold gives
 * hysteresis so capture can't flap on/off right at the boundary.
 *
 * The classifier is pure (no chrome APIs) so the thresholds are unit-testable
 * without filling real storage. Shared by the service worker (writes the state)
 * and the panel adapter (reads the key), so the key + bands stay in one place.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

/** chrome.storage.local quota for an extension without `unlimitedStorage`. */
export const QUOTA_BYTES = 10 * 1024 * 1024; // 10 MiB
/** Pause capture + warn at/above this (80% of quota). */
export const WARN_BYTES = Math.floor(QUOTA_BYTES * 0.8); // 8 MiB
/** Resume capture once usage drops below this (75% — hysteresis under WARN_BYTES). */
export const RESUME_BYTES = Math.floor(QUOTA_BYTES * 0.75); // 7.5 MiB

/** Key the service worker publishes the current pressure state under; panel watches it. */
export const STORAGE_QUOTA_KEY = 'docentStorageQuota';

/**
 * Classify storage pressure into a band: 'ok' | 'warn' | 'exceeded'.
 *
 * Hysteresis: the band enters 'warn' at/above WARN_BYTES and stays 'warn' until
 * usage drops below the lower RESUME_BYTES, so it can't flap across the boundary.
 * A hard QuotaExceededError on write short-circuits to 'exceeded'. The pause and
 * user-override decisions are layered on top of the band by the service worker
 * (warn auto-pauses unless the user chose to keep recording; exceeded always
 * pauses — nothing writes past a physically full quota).
 *
 * @param {number} bytesInUse — current chrome.storage.local usage
 * @param {boolean} wasWarn — whether the band was already 'warn' (for hysteresis)
 * @param {boolean} [exceeded] — a QuotaExceededError was just thrown on write
 * @returns {'ok' | 'warn' | 'exceeded'}
 */
export function classifyStoragePressure(bytesInUse, wasWarn, exceeded = false) {
  if (exceeded) return 'exceeded';
  const warn = wasWarn ? bytesInUse >= RESUME_BYTES : bytesInUse >= WARN_BYTES;
  return warn ? 'warn' : 'ok';
}
