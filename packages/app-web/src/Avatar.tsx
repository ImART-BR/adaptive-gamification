export function Avatar({ avatar, frame, big = false }: { avatar: string; frame: string; big?: boolean }) {
  return (
    <span className={`avatar ${frame !== 'nenhuma' ? frame : ''} ${big ? 'big' : ''}`} aria-hidden="true">
      {avatar}
    </span>
  );
}
