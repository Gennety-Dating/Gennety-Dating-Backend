/**
 * Minimal Leaflet type shim. Leaflet is loaded as a CDN `<script>` in
 * `location.html` (global `L`), so we don't pull `leaflet` as an npm dependency
 * — it stays a script include (AGENTS.md: no new deps without approval; approved
 * as a CDN include, same as the map lib it replaced).
 *
 * Only the surface used by `src/location.ts` is typed. Leaflet uses [lat, lng]
 * order (the opposite of GeoJSON [lng, lat]).
 */

declare namespace L {
  interface LatLng {
    lat: number;
    lng: number;
  }
  type LatLngTuple = [number, number];

  interface MapOptions {
    center?: LatLngTuple | LatLng;
    zoom?: number;
    zoomControl?: boolean;
    attributionControl?: boolean;
    dragging?: boolean;
  }

  interface TileLayerOptions {
    subdomains?: string | string[];
    attribution?: string;
    maxZoom?: number;
    detectRetina?: boolean;
  }

  interface SetViewOptions {
    animate?: boolean;
  }

  interface AttributionControl {
    setPrefix(prefix: string | false): this;
  }

  class Map {
    attributionControl: AttributionControl;
    on(type: "moveend" | "movestart" | "load", listener: () => void): this;
    getCenter(): LatLng;
    setView(center: LatLngTuple | LatLng, zoom?: number, options?: SetViewOptions): this;
    invalidateSize(animate?: boolean): this;
    remove(): this;
  }

  class TileLayer {
    addTo(map: Map): this;
  }

  function map(el: string | HTMLElement, options?: MapOptions): Map;
  function tileLayer(url: string, options?: TileLayerOptions): TileLayer;
}

interface Window {
  L: typeof L;
}
