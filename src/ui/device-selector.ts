/**
 * DeviceSelectorView — view (5) from the Phase 6 brief: "audio device selector
 * (mic/speaker) persisted per agent — this desktop also runs the ACD WebRTC
 * engine, so explicit device choice matters."
 *
 * Enumerates devices via `navigator.mediaDevices.enumerateDevices()`, lets the
 * agent pick a mic + speaker, and persists the choice per `agent-id` via
 * device-store.ts (deviceId only — see that file's header for the "never a token"
 * rule). The speaker choice is applied immediately with
 * `HTMLMediaElement.setSinkId` on the remote-audio sink this view is given, where
 * the browser supports it (Chromium; feature-detected, never assumed).
 *
 * The mic choice is persisted and reported via `UiActions.setMicDevice` for
 * whoever wires the calling backend to use — this view has no reference to (and
 * must not import) the calling backend or the SDK; it only remembers and reports
 * the choice, per BUILD-PLAN.md's "no business logic in UI code" rule.
 */

import type { UiActions } from './types';
import { getStoredDevice, setStoredDevice } from './device-store';
import { clear, el } from './dom';

/**
 * The subset of setSinkId-capable media elements. `setSinkId` is feature-detected
 * at every call site (`typeof audio.setSinkId === 'function'`), never assumed —
 * TS's DOM lib already types it as present-but-experimental on some versions, so
 * this is declared as an intersection (not `interface … extends`) to avoid
 * conflicting with whatever the current lib.dom.d.ts declares.
 */
type SinkCapableElement = HTMLMediaElement & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

export class DeviceSelectorView {
  readonly element: HTMLElement;
  private readonly actions: UiActions;
  private agentId = '';
  private remoteAudio: SinkCapableElement | null = null;
  private micSelect: HTMLSelectElement;
  private speakerSelect: HTMLSelectElement;
  private deviceChangeHandler: (() => void) | null = null;

  constructor(actions: UiActions) {
    this.actions = actions;
    this.element = el('div', 'vw-device-selector');

    const micRow = el('div', 'vw-device-row');
    micRow.appendChild(el('label', undefined, 'Microphone'));
    this.micSelect = document.createElement('select');
    this.micSelect.setAttribute('aria-label', 'Microphone');
    micRow.appendChild(this.micSelect);

    const speakerRow = el('div', 'vw-device-row');
    speakerRow.appendChild(el('label', undefined, 'Speaker'));
    this.speakerSelect = document.createElement('select');
    this.speakerSelect.setAttribute('aria-label', 'Speaker');
    speakerRow.appendChild(this.speakerSelect);

    this.element.appendChild(micRow);
    this.element.appendChild(speakerRow);

    this.micSelect.addEventListener('change', () => {
      if (!this.micSelect.value) return;
      setStoredDevice(this.agentId, 'mic', this.micSelect.value);
      this.actions.setMicDevice(this.micSelect.value);
    });
    this.speakerSelect.addEventListener('change', () => {
      if (!this.speakerSelect.value) return;
      setStoredDevice(this.agentId, 'speaker', this.speakerSelect.value);
      this.actions.setSpeakerDevice(this.speakerSelect.value);
      this.applySinkId(this.speakerSelect.value);
    });
  }

  /** The remote-audio element whose output device this view controls (speaker only). */
  setRemoteAudioElement(el: HTMLMediaElement | null): void {
    this.remoteAudio = el;
  }

  /** Re-init for a (possibly new) agent id, then (re)enumerate devices. */
  async start(agentId: string): Promise<void> {
    this.agentId = agentId;
    await this.refresh();
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) return;
    this.deviceChangeHandler = () => {
      void this.refresh();
    };
    navigator.mediaDevices.addEventListener?.('devicechange', this.deviceChangeHandler);
  }

  dispose(): void {
    if (this.deviceChangeHandler && typeof navigator !== 'undefined' && navigator.mediaDevices) {
      navigator.mediaDevices.removeEventListener?.('devicechange', this.deviceChangeHandler);
    }
    this.deviceChangeHandler = null;
  }

  private async refresh(): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
      this.renderUnavailable();
      return;
    }
    let devices: MediaDeviceInfo[];
    try {
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch {
      this.renderUnavailable();
      return;
    }
    const mics = devices.filter((d) => d.kind === 'audioinput');
    const speakers = devices.filter((d) => d.kind === 'audiooutput');

    this.populate(this.micSelect, mics, 'Microphone', getStoredDevice(this.agentId, 'mic'));
    this.populate(this.speakerSelect, speakers, 'Speaker', getStoredDevice(this.agentId, 'speaker'));

    if (this.speakerSelect.value) this.applySinkId(this.speakerSelect.value);
  }

  private renderUnavailable(): void {
    clear(this.micSelect);
    clear(this.speakerSelect);
    const opt = document.createElement('option');
    opt.textContent = 'Not available in this browser';
    opt.value = '';
    this.micSelect.appendChild(opt);
    this.speakerSelect.appendChild(opt.cloneNode(true));
    this.micSelect.disabled = true;
    this.speakerSelect.disabled = true;
  }

  private populate(
    select: HTMLSelectElement,
    devices: MediaDeviceInfo[],
    fallbackLabel: string,
    preferredId: string | null,
  ): void {
    clear(select);
    select.disabled = devices.length === 0;
    if (devices.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No devices found';
      select.appendChild(opt);
      return;
    }
    let matchedPreferred = false;
    devices.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `${fallbackLabel} ${i + 1}`;
      select.appendChild(opt);
      if (preferredId && d.deviceId === preferredId) matchedPreferred = true;
    });
    if (preferredId && matchedPreferred) {
      select.value = preferredId;
    }
  }

  private applySinkId(deviceId: string): void {
    const audio = this.remoteAudio;
    if (!audio || typeof audio.setSinkId !== 'function') return;
    void audio.setSinkId(deviceId).catch(() => {
      // Best-effort: an unsupported/invalid sink must not break the call.
    });
  }
}
