import { useEffect } from 'react';
import { ensureThemeInitialized, useThemeStore, } from '../../state/theme';

export type { ThemePreference } from '../../state/theme';

export function useThemePreference() {
	const preference = useThemeStore((state) => state.preference);
	const setPreference = useThemeStore((state) => state.setPreference);

	useEffect(() => {
		ensureThemeInitialized();
	}, []);

	return [preference, setPreference] as const;
}

