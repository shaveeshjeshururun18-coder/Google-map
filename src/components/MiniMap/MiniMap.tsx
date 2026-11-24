import React, { useMemo, useState } from 'react';
import {
  AdvancedMarker,
  Map as GoogleMap,
} from '@vis.gl/react-google-maps';
import { Compass, Map as MapIcon, X } from 'lucide-react';
import type {
  NavigationHistoryEntry,
  PanoramaEdge,
  PanoramaMetadata,
  PanoramaNode,
} from '../../types/streetview';
import { degToRad } from '../../utils/geo';

interface MiniMapProps {
  currentMetadata: PanoramaMetadata | null;
  heading: number;
  nodes: PanoramaNode[];
  edges: PanoramaEdge[];
  history: NavigationHistoryEntry[];
  onSelectLocation: (lat: number, lng: number, label?: string) => void;
  onClose: () => void;
}

const MAPS_JS_API_KEY = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '').trim();

const GraphRadarCanvas: React.FC<{
  currentMetadata: PanoramaMetadata;
  heading: number;
  nodes: PanoramaNode[];
  edges: PanoramaEdge[];
  history: NavigationHistoryEntry[];
  onSelectLocation: (lat: number, lng: number, label?: string) => void;
}> = ({ currentMetadata, heading, nodes, edges, history, onSelectLocation }) => {
  const size = 240;
  const center = size / 2;
  const scaleMetersPerPx = 0.85; // ~100m radius radar

  const project = (lat: number, lng: number) => {
    const cosLat = Math.cos(degToRad(currentMetadata.lat));
    const dxMeters = (lng - currentMetadata.lng) * 111_320 * cosLat;
    const dyMeters = (lat - currentMetadata.lat) * 110_540;
    return {
      x: center + dxMeters / scaleMetersPerPx,
      y: center - dyMeters / scaleMetersPerPx,
    };
  };

  const nodeLookup: Record<string, PanoramaNode> = {};
  for (const n of nodes) {
    nodeLookup[n.panoId] = n;
  }

  const currentEdges = edges.filter((e) => e.sourcePanoId === currentMetadata.panoId);
  const headingRad = degToRad(heading);
  const coneLeft = degToRad(heading - 28);
  const coneRight = degToRad(heading + 28);
  const coneLen = 44;
  const conePath = `M ${center} ${center} L ${center + Math.sin(coneLeft) * coneLen} ${
    center - Math.cos(coneLeft) * coneLen
  } L ${center + Math.sin(coneRight) * coneLen} ${center - Math.cos(coneRight) * coneLen} Z`;

  const historyPath = useMemo(() => {
    if (history.length < 2) return '';
    return history
      .slice(-30)
      .map((pt, idx) => {
        const p = project(pt.lat, pt.lng);
        return `${idx === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
      })
      .join(' ');
  }, [history, currentMetadata.lat, currentMetadata.lng]);

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className="w-full h-[220px] bg-[#090C11] block"
      role="img"
      aria-label={`Panorama navigation graph centered on ${currentMetadata.streetName}`}
    >
      {/* Distance reference rings (40m, 80m) */}
      <circle
        cx={center}
        cy={center}
        r={40 / scaleMetersPerPx}
        fill="none"
        stroke="rgba(255,255,255,0.08)"
        strokeDasharray="3 3"
      />
      <circle
        cx={center}
        cy={center}
        r={80 / scaleMetersPerPx}
        fill="none"
        stroke="rgba(255,255,255,0.06)"
      />

      {/* Cardinal labels */}
      <text x={center} y={14} textAnchor="middle" fill="#94A3B8" fontSize="10" fontWeight="600">
        N
      </text>
      <text x={size - 10} y={center + 3} textAnchor="end" fill="#64748B" fontSize="9">
        E
      </text>
      <text x={center} y={size - 6} textAnchor="middle" fill="#64748B" fontSize="9">
        S
      </text>
      <text x={10} y={center + 3} textAnchor="start" fill="#64748B" fontSize="9">
        W
      </text>

      {/* Traversed route polyline */}
      {historyPath && (
        <path
          d={historyPath}
          fill="none"
          stroke="#38BDF8"
          strokeWidth="2"
          strokeOpacity="0.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}

      {/* Discovered graph edges */}
      {edges.map((edge) => {
        const src = nodeLookup[edge.sourcePanoId];
        const dst = nodeLookup[edge.destinationPanoId];
        if (!src || !dst) return null;
        const p1 = project(src.metadata.lat, src.metadata.lng);
        const p2 = project(dst.metadata.lat, dst.metadata.lng);
        return (
          <line
            key={`${edge.sourcePanoId}->${edge.destinationPanoId}`}
            x1={p1.x}
            y1={p1.y}
            x2={p2.x}
            y2={p2.y}
            stroke="rgba(245,158,11,0.4)"
            strokeWidth="1.5"
          />
        );
      })}

      {/* Immediate outgoing link vectors from current panorama */}
      {currentEdges.map((edge) => {
        const rad = degToRad(edge.heading);
        const len = 34;
        return (
          <line
            key={`vec-${edge.destinationPanoId}`}
            x1={center}
            y1={center}
            x2={center + Math.sin(rad) * len}
            y2={center - Math.cos(rad) * len}
            stroke="#F59E0B"
            strokeWidth="2"
            strokeOpacity="0.85"
          />
        );
      })}

      {/* Discovered panorama nodes (clickable to revisit) */}
      {nodes.map((node) => {
        const p = project(node.metadata.lat, node.metadata.lng);
        if (p.x < 4 || p.x > size - 4 || p.y < 4 || p.y > size - 4) return null;
        const isCurrent = node.panoId === currentMetadata.panoId;
        return (
          <circle
            key={node.panoId}
            cx={p.x}
            cy={p.y}
            r={isCurrent ? 5 : 3.5}
            fill={isCurrent ? '#F59E0B' : '#94A3B8'}
            stroke="#0B0E14"
            strokeWidth="1.5"
            className="cursor-pointer"
            onClick={() =>
              onSelectLocation(node.metadata.lat, node.metadata.lng, node.metadata.streetName)
            }
          >
            <title>{node.metadata.streetName}</title>
          </circle>
        );
      })}

      {/* Vehicle camera viewing cone */}
      <path d={conePath} fill="rgba(245,158,11,0.20)" />
      <line
        x1={center}
        y1={center}
        x2={center + Math.sin(headingRad) * 26}
        y2={center - Math.cos(headingRad) * 26}
        stroke="#F59E0B"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <circle cx={center} cy={center} r={4.5} fill="#F59E0B" stroke="#0B0E14" strokeWidth="1.5" />
    </svg>
  );
};

export const MiniMap: React.FC<MiniMapProps> = ({
  currentMetadata,
  heading,
  nodes,
  edges,
  history,
  onSelectLocation,
  onClose,
}) => {
  const hasGoogleMapJs = MAPS_JS_API_KEY.length > 0;
  const [viewMode, setViewMode] = useState<'map' | 'graph'>(hasGoogleMapJs ? 'map' : 'graph');

  if (!currentMetadata) {
    return null;
  }

  return (
    <aside
      aria-label="Navigation Mini-Map"
      data-testid="minimap-panel"
      className="w-[272px] bg-[#0B0E14]/94 border border-white/14 rounded-xl shadow-2xl overflow-hidden pointer-events-auto"
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
        <div className="flex items-center gap-2 text-xs font-medium text-slate-200">
          {viewMode === 'map' ? (
            <MapIcon className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />
          ) : (
            <Compass className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />
          )}
          <span>{viewMode === 'map' ? 'Road Map' : 'Panorama Graph'}</span>
        </div>

        <div className="flex items-center gap-1">
          {hasGoogleMapJs && (
            <button
              type="button"
              onClick={() => setViewMode(viewMode === 'map' ? 'graph' : 'map')}
              className="px-2 py-1 text-[11px] font-medium text-slate-300 hover:text-white bg-white/6 hover:bg-white/12 rounded transition-colors whitespace-nowrap"
            >
              {viewMode === 'map' ? 'Graph' : 'Map'}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Mini-Map"
            className="p-1 text-slate-400 hover:text-white transition-colors rounded"
          >
            <X className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="relative w-full h-[220px]">
        {viewMode === 'map' && hasGoogleMapJs ? (
          <GoogleMap
            style={{ width: '100%', height: '220px' }}
            center={{ lat: currentMetadata.lat, lng: currentMetadata.lng }}
            defaultZoom={17}
            mapId="DEMO_MAP_ID"
            colorScheme="DARK"
            disableDefaultUI
            gestureHandling="greedy"
            internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
            onClick={(ev) => {
              const ll = ev.detail.latLng;
              if (ll) {
                onSelectLocation(ll.lat, ll.lng, 'Selected Map Point');
              }
            }}
          >
            <AdvancedMarker
              position={{ lat: currentMetadata.lat, lng: currentMetadata.lng }}
              title={currentMetadata.streetName}
            >
              <div
                className="w-4 h-4 rounded-full bg-amber-400 border-2 border-[#0B0E14] shadow-md"
                style={{ transform: `rotate(${Math.round(heading)}deg)` }}
              />
            </AdvancedMarker>
          </GoogleMap>
        ) : (
          <GraphRadarCanvas
            currentMetadata={currentMetadata}
            heading={heading}
            nodes={nodes}
            edges={edges}
            history={history}
            onSelectLocation={onSelectLocation}
          />
        )}
      </div>

      <div className="px-3 py-2 border-t border-white/10 flex items-center justify-between text-[11px] text-slate-400">
        <span>{nodes.length} nodes · {edges.length} links</span>
        <span className="font-telemetry text-slate-300">
          {currentMetadata.lat.toFixed(4)}, {currentMetadata.lng.toFixed(4)}
        </span>
      </div>
    </aside>
  );
};
