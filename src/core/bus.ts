/** Basit olay yayinlayici: cekirdek surec -> arayuz. */
import { EventEmitter } from 'node:events';
import type { KonseyEvent } from '../shared/types';

export class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  emit(event: KonseyEvent): void {
    this.emitter.emit('event', event);
  }

  on(handler: (event: KonseyEvent) => void): () => void {
    this.emitter.on('event', handler);
    return () => this.emitter.off('event', handler);
  }
}
