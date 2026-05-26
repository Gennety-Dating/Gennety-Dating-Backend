/**
 * Minimal Leaflet type shim. Loaded as a CDN `<script>` in
 * `location.html`, so we don't pull `leaflet` as an npm dep
 * (AGENTS.md: no new dependencies without approval).
 *
 * Only the surface used by `src/location.ts` is typed. If we ever
 * lean on more of Leaflet, expand this shim incrementally rather
 * than vendoring `@types/leaflet` wholesale.
 */

declare namespace L {
  interface LatLngLiteral {
    lat: number;
    lng: number;
  }

  interface MapOptions {
    center?: [number, number] | LatLngLiteral;
    zoom?: number;
    zoomControl?: boolean;
    attributionControl?: boolean;
    tap?: boolean;
  }

  interface MarkerOptions {
    draggable?: boolean;
    autoPan?: boolean;
  }

  interface TileLayerOptions {
    attribution?: string;
    maxZoom?: number;
  }

  interface LeafletMouseEvent {
    latlng: { lat: number; lng: number };
  }

  interface LeafletDragEndEvent {
    target: Marker;
  }

  interface Marker {
    setLatLng(latlng: [number, number] | LatLngLiteral): Marker;
    getLatLng(): { lat: number; lng: number };
    addTo(map: Map): Marker;
    on(event: "dragend", handler: (e: LeafletDragEndEvent) => void): Marker;
  }

  interface TileLayer {
    addTo(map: Map): TileLayer;
  }

  interface Map {
    setView(center: [number, number] | LatLngLiteral, zoom?: number): Map;
    on(event: "click", handler: (e: LeafletMouseEvent) => void): Map;
    invalidateSize(): Map;
    remove(): void;
  }

  function map(elementId: string | HTMLElement, options?: MapOptions): Map;
  function marker(latlng: [number, number] | LatLngLiteral, options?: MarkerOptions): Marker;
  function tileLayer(urlTemplate: string, options?: TileLayerOptions): TileLayer;
}

interface Window {
  L: typeof L;
}
