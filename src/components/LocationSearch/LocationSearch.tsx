import React, { useEffect, useRef, useState } from 'react';
import { Crosshair, Loader2, MapPin, Search, X } from 'lucide-react';
import type { PlaceResult, PlaceSuggestion } from '../../types/streetview';

interface LocationSearchProps {
  onAutocomplete: (query: string, signal?: AbortSignal) => Promise<PlaceSuggestion[]>;
  onSearchText: (query: string, signal?: AbortSignal) => Promise<PlaceResult[]>;
  onSelectSuggestion: (suggestion: PlaceSuggestion) => Promise<void>;
  onSelectPlace: (place: PlaceResult) => Promise<void>;
  onLocateDevice: () => void;
  isLocating?: boolean;
  disabled?: boolean;
}

export const LocationSearch: React.FC<LocationSearchProps> = ({
  onAutocomplete,
  onSearchText,
  onSelectSuggestion,
  onSelectPlace,
  onLocateDevice,
  isLocating = false,
  disabled = false,
}) => {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [textResults, setTextResults] = useState<PlaceResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const suppressNextAutocompleteRef = useRef(false);

  // Close dropdown on outside click
  useEffect(() => {
    const handleOutside = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, []);

  // Debounced Places API (New) autocomplete
  useEffect(() => {
    if (suppressNextAutocompleteRef.current) {
      suppressNextAutocompleteRef.current = false;
      return;
    }

    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setSuggestions([]);
      setTextResults([]);
      setSearchError(null);
      return;
    }

    const timer = window.setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setIsSearching(true);
      setSearchError(null);

      try {
        const items = await onAutocomplete(trimmed, controller.signal);
        if (!controller.signal.aborted) {
          setSuggestions(items);
          setTextResults([]);
          setIsOpen(true);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (!controller.signal.aborted) {
          setSearchError(err instanceof Error ? err.message : 'Unable to search locations.');
          setIsOpen(true);
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsSearching(false);
        }
      }
    }, 280);

    return () => {
      window.clearTimeout(timer);
    };
  }, [query, onAutocomplete]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed || disabled) return;

    // Support direct "lat, lng" entry for precision coordinate jumps
    const coordMatch = trimmed.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (coordMatch) {
      const lat = Number(coordMatch[1]);
      const lng = Number(coordMatch[2]);
      if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        setIsOpen(false);
        await onSelectPlace({
          placeId: `coords:${lat},${lng}`,
          name: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
          formattedAddress: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
          lat,
          lng,
          types: ['coordinates'],
        });
        return;
      }
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsSearching(true);
    setSearchError(null);

    try {
      const places = await onSearchText(trimmed, controller.signal);
      if (controller.signal.aborted) return;

      if (places.length === 1) {
        setIsOpen(false);
        await onSelectPlace(places[0]);
      } else if (places.length > 1) {
        setTextResults(places);
        setSuggestions([]);
        setIsOpen(true);
      } else {
        setSearchError(`No locations found matching "${trimmed}".`);
        setTextResults([]);
        setSuggestions([]);
        setIsOpen(true);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setSearchError(err instanceof Error ? err.message : 'Location search failed.');
      setIsOpen(true);
    } finally {
      if (!controller.signal.aborted) {
        setIsSearching(false);
      }
    }
  };

  const handlePickSuggestion = async (item: PlaceSuggestion) => {
    abortRef.current?.abort();
    suppressNextAutocompleteRef.current = true;
    setQuery(item.mainText);
    setIsOpen(false);
    setSuggestions([]);
    setTextResults([]);
    setSearchError(null);
    inputRef.current?.blur();
    await onSelectSuggestion(item);
  };

  const handlePickPlace = async (place: PlaceResult) => {
    abortRef.current?.abort();
    suppressNextAutocompleteRef.current = true;
    setQuery(place.name);
    setIsOpen(false);
    setSuggestions([]);
    setTextResults([]);
    setSearchError(null);
    inputRef.current?.blur();
    await onSelectPlace(place);
  };

  const showDropdown =
    isOpen &&
    (suggestions.length > 0 || textResults.length > 0 || Boolean(searchError));

  return (
    <div ref={wrapperRef} className="relative w-full max-w-md">
      <form
        onSubmit={handleSubmit}
        role="search"
        aria-label="Search street, city, or landmark"
        className="flex items-center bg-[#0B0E14]/92 border border-white/12 rounded-lg focus-within:border-amber-400/70 transition-colors"
      >
        <Search className="w-4 h-4 text-slate-400 ml-2.5 sm:ml-3 shrink-0" aria-hidden="true" />
        <label htmlFor="location-search-input" className="sr-only">
          Search any city, street, landmark, or coordinates
        </label>
        <input
          ref={inputRef}
          id="location-search-input"
          type="text"
          value={query}
          disabled={disabled}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => {
            if (suggestions.length > 0 || textResults.length > 0 || searchError) {
              setIsOpen(true);
            }
          }}
          placeholder="Search city, street, landmark..."
          autoComplete="off"
          className="w-full min-w-0 bg-transparent px-2 sm:px-2.5 py-2 text-xs sm:text-sm text-slate-100 placeholder:text-slate-400 focus:outline-none disabled:opacity-50"
        />

        {isSearching && (
          <Loader2
            className="w-4 h-4 text-amber-400 animate-spin mr-1.5 sm:mr-2 shrink-0"
            aria-label="Searching locations"
          />
        )}

        {query.length > 0 && !isSearching && (
          <button
            type="button"
            onClick={() => {
              abortRef.current?.abort();
              setQuery('');
              setSuggestions([]);
              setTextResults([]);
              setSearchError(null);
              setIsOpen(false);
            }}
            aria-label="Clear search query"
            className="p-1.5 sm:p-2 text-slate-400 hover:text-slate-100 transition-colors shrink-0"
          >
            <X className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        )}

        <button
          type="button"
          onClick={onLocateDevice}
          disabled={disabled || isLocating}
          data-testid="locate-device-btn"
          aria-label="Drive near my current GPS location"
          title="Jump to my current location"
          className={`flex items-center gap-1.5 px-2.5 py-1.5 mr-1 rounded-md text-xs font-medium transition-colors shrink-0 disabled:opacity-50 ${
            isLocating
              ? 'bg-amber-500/20 text-amber-300 border border-amber-400/40'
              : 'text-slate-300 hover:text-amber-400 hover:bg-white/8'
          }`}
        >
          {isLocating ? (
            <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin" aria-hidden="true" />
          ) : (
            <Crosshair className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />
          )}
          <span className="hidden sm:inline">
            {isLocating ? 'Locating...' : 'My Location'}
          </span>
        </button>
      </form>

      {showDropdown && (
        <div
          className="absolute left-0 right-0 mt-1.5 bg-[#0B0E14]/96 border border-white/14 rounded-lg shadow-2xl overflow-hidden z-50 max-h-72 overflow-y-auto"
          role="listbox"
          aria-label="Location search results"
        >
          {searchError && (
            <div className="px-3.5 py-3 text-xs text-rose-300 border-b border-white/8">
              {searchError}
            </div>
          )}

          {suggestions.map((item) => (
            <button
              key={item.placeId}
              type="button"
              role="option"
              aria-selected={false}
              onClick={() => void handlePickSuggestion(item)}
              className="w-full text-left px-3.5 py-2.5 hover:bg-white/8 transition-colors flex items-start gap-2.5 border-b border-white/6 last:border-b-0"
            >
              <MapPin className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" aria-hidden="true" />
              <div className="min-w-0">
                <div className="text-sm font-medium text-slate-100 truncate">
                  {item.mainText}
                </div>
                {item.secondaryText && (
                  <div className="text-xs text-slate-400 truncate">{item.secondaryText}</div>
                )}
              </div>
            </button>
          ))}

          {textResults.map((place) => (
            <button
              key={place.placeId}
              type="button"
              role="option"
              aria-selected={false}
              onClick={() => void handlePickPlace(place)}
              className="w-full text-left px-3.5 py-2.5 hover:bg-white/8 transition-colors flex items-start gap-2.5 border-b border-white/6 last:border-b-0"
            >
              <MapPin className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" aria-hidden="true" />
              <div className="min-w-0">
                <div className="text-sm font-medium text-slate-100 truncate">
                  {place.name}
                </div>
                {place.formattedAddress && (
                  <div className="text-xs text-slate-400 truncate">
                    {place.formattedAddress}
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
