import type {
  DeadEndStatus,
  NavigationHistoryEntry,
  PanoramaEdge,
  PanoramaMetadata,
  RankedNeighbour,
  RelativeDirection,
} from '../types/streetview';
import {
  calculateAngularDifference,
  calculateRelativeDirection,
  normalizeHeading,
} from './DirectionCalculator';
import { PanoramaGraph } from './PanoramaGraph';

const MAX_HISTORY_ENTRIES = 200;

export class NavigationManager {
  public readonly graph: PanoramaGraph;
  private history: NavigationHistoryEntry[] = [];
  private currentIndex = -1;

  constructor(graph: PanoramaGraph = new PanoramaGraph()) {
    this.graph = graph;
  }

  public discoverNeighbours(metadata: PanoramaMetadata): PanoramaEdge[] {
    this.graph.addNode(metadata);
    return this.graph.getEdges(metadata.panoId);
  }

  public calculateRelativeDirection(
    cameraHeadingDeg: number,
    linkHeadingDeg: number,
  ): RelativeDirection {
    return calculateRelativeDirection(cameraHeadingDeg, linkHeadingDeg);
  }

  public getRankedNeighbours(
    panoId: string,
    cameraHeadingDeg: number,
  ): RankedNeighbour[] {
    const edges = this.graph.getEdges(panoId);
    const ranked = edges.map((edge) => {
      const relativeAngle = calculateAngularDifference(cameraHeadingDeg, edge.heading);
      return {
        edge,
        relativeAngle,
        absAngle: Math.abs(relativeAngle),
        direction: calculateRelativeDirection(cameraHeadingDeg, edge.heading),
      };
    });

    ranked.sort((a, b) => a.absAngle - b.absAngle);
    return ranked;
  }

  public findForwardNeighbour(
    panoId: string,
    cameraHeadingDeg: number,
    maxConeDegrees = 60,
  ): RankedNeighbour | null {
    const ranked = this.getRankedNeighbours(panoId, cameraHeadingDeg);
    const candidate = ranked.find((item) => item.absAngle <= maxConeDegrees);
    return candidate ?? null;
  }

  public findLeftNeighbour(
    panoId: string,
    cameraHeadingDeg: number,
  ): RankedNeighbour | null {
    const ranked = this.getRankedNeighbours(panoId, cameraHeadingDeg);
    const leftCandidates = ranked.filter(
      (item) => item.relativeAngle <= -20 && item.relativeAngle >= -150,
    );
    if (leftCandidates.length === 0) return null;

    // Prefer the link closest to a natural left turn (-90°), or the leftmost available
    leftCandidates.sort(
      (a, b) => Math.abs(a.relativeAngle + 90) - Math.abs(b.relativeAngle + 90),
    );
    return leftCandidates[0];
  }

  public findRightNeighbour(
    panoId: string,
    cameraHeadingDeg: number,
  ): RankedNeighbour | null {
    const ranked = this.getRankedNeighbours(panoId, cameraHeadingDeg);
    const rightCandidates = ranked.filter(
      (item) => item.relativeAngle >= 20 && item.relativeAngle <= 150,
    );
    if (rightCandidates.length === 0) return null;

    // Prefer the link closest to a natural right turn (+90°)
    rightCandidates.sort(
      (a, b) => Math.abs(a.relativeAngle - 90) - Math.abs(b.relativeAngle - 90),
    );
    return rightCandidates[0];
  }

  public findReverseNeighbour(
    panoId: string,
    cameraHeadingDeg: number,
  ): RankedNeighbour | null {
    const reverseHeading = normalizeHeading(cameraHeadingDeg + 180);
    const rankedFromBehind = this.getRankedNeighbours(panoId, reverseHeading);
    const directRear = rankedFromBehind.find((item) => item.absAngle <= 65);
    if (directRear) {
      // Return angle relative to the user's forward heading for consistent UI display
      const rel = calculateAngularDifference(cameraHeadingDeg, directRear.edge.heading);
      return {
        edge: directRear.edge,
        relativeAngle: rel,
        absAngle: Math.abs(rel),
        direction: calculateRelativeDirection(cameraHeadingDeg, directRear.edge.heading),
      };
    }

    // Fallback to previous panorama in navigation history if directly linked
    const previous = this.getPreviousHistoryEntry();
    if (previous) {
      const linkToPrev = this.graph.getEdge(panoId, previous.panoId);
      if (linkToPrev) {
        const rel = calculateAngularDifference(cameraHeadingDeg, linkToPrev.heading);
        return {
          edge: linkToPrev,
          relativeAngle: rel,
          absAngle: Math.abs(rel),
          direction: calculateRelativeDirection(cameraHeadingDeg, linkToPrev.heading),
        };
      }
    }

    return null;
  }

  public async loadNeighbour(
    edge: PanoramaEdge,
    fetchMetadata: (panoId: string) => Promise<PanoramaMetadata>,
  ): Promise<PanoramaMetadata> {
    const cachedNode = this.graph.getNode(edge.destinationPanoId);
    if (cachedNode) {
      return cachedNode.metadata;
    }

    const metadata = await fetchMetadata(edge.destinationPanoId);
    this.discoverNeighbours(metadata);
    return metadata;
  }

  public maintainNavigationHistory(
    metadata: PanoramaMetadata,
    heading: number,
  ): NavigationHistoryEntry[] {
    const current = this.getCurrentHistoryEntry();
    if (current && current.panoId === metadata.panoId) {
      current.heading = normalizeHeading(heading);
      return this.getHistory();
    }

    const entry: NavigationHistoryEntry = {
      panoId: metadata.panoId,
      lat: metadata.lat,
      lng: metadata.lng,
      streetName: metadata.streetName,
      enteredAt: Date.now(),
      heading: normalizeHeading(heading),
    };

    // If user moved from an earlier history index, truncate forward branch
    if (this.currentIndex >= 0 && this.currentIndex < this.history.length - 1) {
      this.history = this.history.slice(0, this.currentIndex + 1);
    }

    this.history.push(entry);
    if (this.history.length > MAX_HISTORY_ENTRIES) {
      this.history.shift();
    }
    this.currentIndex = this.history.length - 1;

    return this.getHistory();
  }

  public getCurrentHistoryEntry(): NavigationHistoryEntry | null {
    if (this.currentIndex < 0 || this.currentIndex >= this.history.length) {
      return null;
    }
    return this.history[this.currentIndex];
  }

  public getPreviousHistoryEntry(): NavigationHistoryEntry | null {
    if (this.currentIndex <= 0) {
      return null;
    }
    return this.history[this.currentIndex - 1];
  }

  public getNextHistoryEntry(): NavigationHistoryEntry | null {
    if (this.currentIndex < 0 || this.currentIndex >= this.history.length - 1) {
      return null;
    }
    return this.history[this.currentIndex + 1];
  }

  public getHistory(): NavigationHistoryEntry[] {
    return [...this.history];
  }

  public detectDeadEnds(panoId: string, cameraHeadingDeg: number): DeadEndStatus {
    const edges = this.graph.getEdges(panoId);
    const forward = this.findForwardNeighbour(panoId, cameraHeadingDeg, 60);

    return {
      isDeadEnd: edges.length === 0 || (edges.length === 1 && !forward),
      isForwardBlocked: !forward,
      isIntersection: edges.length >= 3,
      availableCount: edges.length,
    };
  }

  public reset(): void {
    this.graph.clear();
    this.history = [];
    this.currentIndex = -1;
  }
}
