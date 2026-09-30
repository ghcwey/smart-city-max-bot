export interface Layout { entrances: number; floors: number; perFloor: number; perEntrance: number }
export interface Spot { entrance: number; floor: number; column: number }
export type Relation = 'source' | 'flood' | 'riser';
export interface ZoneCell { apartment: number; floor: number; relation: Relation }

export const FLOOD_FLOORS = 2;

export function layoutOf(h: { entrances: number; floors: number; apartmentsCount: number }): Layout | null {
  const perEntrance = h.apartmentsCount / h.entrances;
  const perFloor = perEntrance / h.floors;
  if (!Number.isInteger(perEntrance) || !Number.isInteger(perFloor) || perFloor < 1) return null;
  return { entrances: h.entrances, floors: h.floors, perFloor, perEntrance };
}

export function locate(l: Layout, apartment: number): Spot | null {
  if (!Number.isInteger(apartment) || apartment < 1 || apartment > l.perEntrance * l.entrances) return null;
  const i = apartment - 1;
  const inEntrance = i % l.perEntrance;
  return {
    entrance: Math.floor(i / l.perEntrance) + 1,
    floor: Math.floor(inEntrance / l.perFloor) + 1,
    column: inEntrance % l.perFloor,
  };
}

function apartmentAt(l: Layout, entrance: number, floor: number, column: number): number {
  return (entrance - 1) * l.perEntrance + (floor - 1) * l.perFloor + column + 1;
}

export function sameRiser(l: Layout, a: number, b: number): boolean {
  const x = locate(l, a);
  const y = locate(l, b);
  return !!x && !!y && x.entrance === y.entrance && x.column === y.column;
}

export function riserZone(l: Layout, apartment: number): ZoneCell[] {
  const s = locate(l, apartment);
  if (!s) return [];
  const cells: ZoneCell[] = [];
  for (let floor = 1; floor <= l.floors; floor++) {
    const relation: Relation = floor === s.floor ? 'source'
      : floor < s.floor && s.floor - floor <= FLOOD_FLOORS ? 'flood'
      : 'riser';
    cells.push({ apartment: apartmentAt(l, s.entrance, floor, s.column), floor, relation });
  }
  return cells;
}

export function apartmentsInScope(l: Layout, scope: { kind: 'house' } | { kind: 'entrance'; entrance: number } | { kind: 'riser'; apartment: number }): number[] {
  const all = Array.from({ length: l.perEntrance * l.entrances }, (_, i) => i + 1);
  if (scope.kind === 'house') return all;
  if (scope.kind === 'entrance') return all.filter(a => locate(l, a)?.entrance === scope.entrance);
  return all.filter(a => sameRiser(l, a, scope.apartment));
}
