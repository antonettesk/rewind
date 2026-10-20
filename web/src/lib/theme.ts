import { useEffect, useState } from 'react';

/** Theme preference: stored per browser; defaults to the OS setting. */
export function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    try {
      localStorage.setItem('rewind.theme', dark ? 'dark' : 'light');
    } catch {
      /* preference not persisted */
    }
  }, [dark]);
  return [dark, setDark] as const;
}
