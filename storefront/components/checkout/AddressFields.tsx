'use client';

import { useState } from 'react';
import { api, errorMessage } from '@/lib/api/client';
import { type AddressForm, PROVINCES } from '@/lib/checkout';
import type { GeocodeCandidate } from '@/lib/commerce-types';
import { LocationPicker } from '../map/LocationPicker';

/**
 * Dirección de Ecuador (calle principal y secundaria, como se escriben aquí) más el pin en el
 * mapa. Con sesión, "Buscar en el mapa" geocodifica con Nominatim (POST /me/addresses/geocode).
 */
export function AddressFields({ value, onChange, geocode }: { value: AddressForm; onChange: (a: AddressForm) => void; geocode: boolean }) {
  const [candidates, setCandidates] = useState<GeocodeCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [geoMsg, setGeoMsg] = useState<string | null>(null);
  const set = (k: keyof AddressForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => onChange({ ...value, [k]: e.target.value });

  async function search() {
    setSearching(true);
    setGeoMsg(null);
    setCandidates([]);
    try {
      const res = await api<{ status: string; candidates: GeocodeCandidate[] }>('/me/addresses/geocode', {
        method: 'POST',
        body: {
          province: value.province,
          city: value.city.trim(),
          mainStreet: value.mainStreet.trim(),
          ...(value.secondaryStreet.trim() ? { crossStreet: value.secondaryStreet.trim() } : {}),
          ...(value.number.trim() ? { houseNumber: value.number.trim() } : {}),
          ...(value.neighborhood.trim() ? { neighborhood: value.neighborhood.trim() } : {}),
        },
      });
      if (res.candidates.length === 0) setGeoMsg(res.status === 'unavailable' || res.status === 'disabled' ? 'El buscador de direcciones no está disponible: marca tu puerta en el mapa.' : 'No encontramos esa dirección: marca tu puerta en el mapa.');
      else if (res.candidates.length === 1) onChange({ ...value, lat: res.candidates[0].lat, lng: res.candidates[0].lng });
      else setCandidates(res.candidates);
    } catch (e) {
      setGeoMsg(errorMessage(e));
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="a-main">
            Calle principal
          </label>
          <input id="a-main" autoComplete="address-line1" className="input" placeholder="Av. Amazonas" value={value.mainStreet} onChange={set('mainStreet')} maxLength={200} />
        </div>
        <div>
          <label className="label" htmlFor="a-sec">
            Calle secundaria
          </label>
          <input id="a-sec" className="input" placeholder="Naciones Unidas" value={value.secondaryStreet} onChange={set('secondaryStreet')} maxLength={200} />
        </div>
        <div>
          <label className="label" htmlFor="a-num">
            Número / lote
          </label>
          <input id="a-num" className="input" placeholder="N34-120" value={value.number} onChange={set('number')} maxLength={20} />
        </div>
        <div>
          <label className="label" htmlFor="a-hood">
            Barrio o sector
          </label>
          <input id="a-hood" className="input" placeholder="La Carolina" value={value.neighborhood} onChange={set('neighborhood')} maxLength={120} />
        </div>
        <div>
          <label className="label" htmlFor="a-city">
            Ciudad
          </label>
          <input id="a-city" autoComplete="address-level2" className="input" value={value.city} onChange={set('city')} maxLength={80} />
        </div>
        <div>
          <label className="label" htmlFor="a-prov">
            Provincia
          </label>
          <select id="a-prov" className="input" value={value.province} onChange={set('province')}>
            {PROVINCES.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor="a-ref">
            Referencia
          </label>
          <input id="a-ref" className="input" placeholder="Edificio azul, junto a la farmacia" value={value.reference} onChange={set('reference')} maxLength={300} />
        </div>
      </div>
      {geocode && (
        <div>
          <button type="button" className="btn-ghost" onClick={() => void search()} disabled={searching || value.mainStreet.trim().length < 2 || value.city.trim().length < 2}>
            {searching ? 'Buscando…' : 'Buscar en el mapa'}
          </button>
          {geoMsg && <p className="mt-2 text-xs text-ink-soft">{geoMsg}</p>}
          {candidates.length > 1 && (
            <ul className="mt-2 space-y-1">
              {candidates.map((c) => (
                <li key={`${c.lat},${c.lng}`}>
                  <button
                    type="button"
                    className="w-full rounded-lg border border-line bg-white px-3 py-2 text-left text-xs hover:border-ink"
                    onClick={() => {
                      onChange({ ...value, lat: c.lat, lng: c.lng });
                      setCandidates([]);
                    }}
                  >
                    {c.displayName}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <LocationPicker value={value.lat !== null && value.lng !== null ? { lat: value.lat, lng: value.lng } : null} onChange={(p) => onChange({ ...value, ...p })} />
    </div>
  );
}
