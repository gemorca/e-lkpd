// Pembanding data spreadsheet: abaikan spasi dan huruf besar-kecil, aman untuk angka.
export const norm = (v) => String(v === null || v === undefined ? '' : v).trim().toLowerCase();
export const sama = (a, b) => norm(a) === norm(b);
export const isPublish = (status) => norm(status) === 'publish';
export const kelasCocok = (idKelas, kelasUser) => {
  const k = norm(idKelas);
  const u = norm(kelasUser);
  return k === 'all' || (u !== '' && u !== '-' && k === u);
};
