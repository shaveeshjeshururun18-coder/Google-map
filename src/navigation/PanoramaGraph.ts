import type {
  PanoramaEdge,
  PanoramaMetadata,
  PanoramaNode,
} from '../types/streetview';
import {
  DEFAULT_ESTIMATED_TRANSITION_METERS,
  haversineDistanceMeters,
} from '../utils/geo';
import { normalizeHeading } from './DirectionCalculator';

export class PanoramaGraph {
  private readonly nodes = new Map<string, PanoramaNode>();
  private readonly adjacency = new Map<string, Map<string, PanoramaEdge>>();

  public addNode(metadata: PanoramaMetadata): PanoramaNode {
    const existing = this.nodes.get(metadata.panoId);
    const node: PanoramaNode = existing
      ? {
          ...existing,
          metadata,
          visitedCount: existing.visitedCount + 1,
        }
      : {
          panoId: metadata.panoId,
          metadata,
          discoveredAt: Date.now(),
          visitedCount: 1,
        };

    this.nodes.set(metadata.panoId, node);

    // Ensure adjacency map entry exists
    let edgeMap = this.adjacency.get(metadata.panoId);
    if (!edgeMap) {
      edgeMap = new Map<string, PanoramaEdge>();
      this.adjacency.set(metadata.panoId, edgeMap);
    }

    // Add deduplicated official links from metadata
    for (const link of metadata.links) {
      if (!link.panoId || link.panoId === metadata.panoId) {
        continue;
      }

      const destNode = this.nodes.get(link.panoId);
      const computedDistance = this.computeEdgeDistance(metadata, destNode?.metadata);

      const edge: PanoramaEdge = {
        sourcePanoId: metadata.panoId,
        destinationPanoId: link.panoId,
        heading: normalizeHeading(link.heading),
        text: link.text?.trim() || metadata.streetName || 'Connected Road',
        distanceMeters: computedDistance.distanceMeters,
        distanceEstimated: computedDistance.estimated,
      };

      edgeMap.set(link.panoId, edge);
    }

    // Back-fill exact distances for any previously discovered incoming edges pointing to this node
    this.recomputeIncomingEdgeDistances(metadata);

    return node;
  }

  private computeEdgeDistance(
    source: PanoramaMetadata,
    dest?: PanoramaMetadata,
  ): { distanceMeters: number; estimated: boolean } {
    if (
      dest &&
      Number.isFinite(source.lat) &&
      Number.isFinite(source.lng) &&
      Number.isFinite(dest.lat) &&
      Number.isFinite(dest.lng)
    ) {
      const dist = haversineDistanceMeters(source.lat, source.lng, dest.lat, dest.lng);
      if (Number.isFinite(dist) && dist >= 1.5 && dist <= 150) {
        return { distanceMeters: dist, estimated: false };
      }
    }
    return {
      distanceMeters: DEFAULT_ESTIMATED_TRANSITION_METERS,
      estimated: true,
    };
  }

  private recomputeIncomingEdgeDistances(destMetadata: PanoramaMetadata): void {
    for (const [sourceId, edgeMap] of this.adjacency.entries()) {
      const incoming = edgeMap.get(destMetadata.panoId);
      if (!incoming) continue;
      const sourceNode = this.nodes.get(sourceId);
      if (!sourceNode) continue;

      const updated = this.computeEdgeDistance(sourceNode.metadata, destMetadata);
      edgeMap.set(destMetadata.panoId, {
        ...incoming,
        distanceMeters: updated.distanceMeters,
        distanceEstimated: updated.estimated,
      });
    }
  }

  public getNode(panoId: string): PanoramaNode | undefined {
    return this.nodes.get(panoId);
  }

  public hasNode(panoId: string): boolean {
    return this.nodes.has(panoId);
  }

  public getEdges(panoId: string): PanoramaEdge[] {
    const edgeMap = this.adjacency.get(panoId);
    if (!edgeMap) return [];
    return Array.from(edgeMap.values());
  }

  public getEdge(sourcePanoId: string, destinationPanoId: string): PanoramaEdge | undefined {
    return this.adjacency.get(sourcePanoId)?.get(destinationPanoId);
  }

  public getAllNodes(): PanoramaNode[] {
    return Array.from(this.nodes.values());
  }

  public getAllEdges(): PanoramaEdge[] {
    const all: PanoramaEdge[] = [];
    for (const edgeMap of this.adjacency.values()) {
      for (const edge of edgeMap.values()) {
        all.push(edge);
      }
    }
    return all;
  }

  public getNodeCount(): number {
    return this.nodes.size;
  }

  public getEdgeCount(): number {
    let count = 0;
    for (const edgeMap of this.adjacency.values()) {
      count += edgeMap.size;
    }
    return count;
  }

  public clear(): void {
    this.nodes.clear();
    this.adjacency.clear();
  }
}
