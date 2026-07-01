/**
 * Minimal MapLibre GL type shim. Loaded as a CDN `<script>` in
 * `location.html` (global `maplibregl`), so we don't pull `maplibre-gl` as an
 * npm dependency — it stays a script include exactly like the old Leaflet one
 * (AGENTS.md: no new deps without approval; approved as a CDN include).
 *
 * Only the surface used by `src/location.ts` is typed. Expand incrementally if
 * we ever lean on more of MapLibre rather than vendoring the full `@types`.
 */

declare namespace maplibregl {
  type LngLatLike = [number, number] | { lng: number; lat: number };

  interface LngLat {
    lng: number;
    lat: number;
  }

  interface MapOptions {
    container: string | HTMLElement;
    style: string;
    center?: LngLatLike;
    zoom?: number;
    attributionControl?: boolean;
    dragRotate?: boolean;
    pitchWithRotate?: boolean;
    touchPitch?: boolean;
  }

  interface JumpToOptions {
    center?: LngLatLike;
    zoom?: number;
  }

  interface TouchZoomRotateHandler {
    disableRotation(): void;
  }

  class Map {
    constructor(options: MapOptions);
    touchZoomRotate: TouchZoomRotateHandler;
    on(type: "moveend" | "movestart" | "load", listener: () => void): this;
    getCenter(): LngLat;
    jumpTo(options: JumpToOptions): this;
    setCenter(center: LngLatLike): this;
    resize(): this;
    remove(): void;
  }
}

interface Window {
  maplibregl: typeof maplibregl;
}
