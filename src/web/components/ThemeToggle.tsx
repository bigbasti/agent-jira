import {useTheme} from '../lib/theme.js';
import {Switch} from './ui/Switch.js';

/** One shared theme across every mount — the whole palette is a token swap. */
export function ThemeToggle({className}: {className?: string}) {
  const {theme, setTheme} = useTheme();

  return (
    <Switch
      label="Light"
      checked={theme === 'light'}
      onCheckedChange={on => setTheme(on ? 'light' : 'dark')}
      className={className}
    />
  );
}
