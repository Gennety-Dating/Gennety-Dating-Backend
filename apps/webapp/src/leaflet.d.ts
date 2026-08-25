/**
 * Minimal Leaflet type shim. Leaflet is loaded as a CDN `<script>` in
 * `location.html` (global `L`), so we don't pull `leaflet` as an npm dependency
 * — it stays a script include (AGENTS.md: no new deps without approval; approved
 * as a CDN include, same as the map lib it replaced).
 *
 * Only the surface used by `src/location.ts` and `src/canvas.ts` is typed.
 * Leaflet uses [lat, lng] order (the opposite of GeoJSON [lng, lat]).
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

  interface Point {
    x: number;
    y: number;
  }

  class Map {
    attributionControl: AttributionControl;
    // `move`/`zoom` fire continuously through a gesture, unlike their `*end`
    // twins. The Scratch Map's fog is drawn in container pixels, so it has to
    // follow the city rather than catch up with it when the finger lifts.
    on(
      type: "moveend" | "movestart" | "load" | "move" | "zoom",
      listener: () => void,
    ): this;
    getCenter(): LatLng;
    /** Container size in pixels. Optional — a stubbed map degrades to the
        element's own size rather than throwing inside the fog renderer. */
    getSize?(): Point;
    /** Projects a coordinate to a pixel inside the map container. Optional for
        the same reason as `getSize`. */
    latLngToContainerPoint?(latlng: LatLngTuple | LatLng): Point;
    setView(center: LatLngTuple | LatLng, zoom?: number, options?: SetViewOptions): this;
    invalidateSize(animate?: boolean): this;
    remove(): this;
  }

  class TileLayer {
    /** Optional so a stubbed layer without it degrades instead of throwing
        inside `initMap`'s try/catch and taking the whole map down with it. */
    once?(type: "tileload" | "load", listener: () => void): this;
    addTo(map: Map): this;
  }

  interface DivIconOptions {
    className?: string;
    html?: string;
    iconSize?: [number, number];
    iconAnchor?: [number, number];
  }

  interface DivIcon {
    readonly __divIcon: unique symbol;
  }

  interface MarkerOptions {
    icon?: DivIcon;
  }

  class Marker {
    addTo(map: Map): this;
    setLatLng(latlng: LatLngTuple | LatLng): this;
    remove(): this;
  }

  function map(el: string | HTMLElement, options?: MapOptions): Map;
  function tileLayer(url: string, options?: TileLayerOptions): TileLayer;
  function marker(latlng: LatLngTuple | LatLng, options?: MarkerOptions): Marker;
  function divIcon(options?: DivIconOptions): DivIcon;
}

interface Window {
  L: typeof L;
}
