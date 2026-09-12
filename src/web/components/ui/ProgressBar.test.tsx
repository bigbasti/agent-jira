import {render, screen} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import {ProgressBar} from './ProgressBar.js';

describe('ProgressBar', () => {
  it('renders the percentage as an accessible progressbar', () => {
    render(<ProgressBar value={42} label="Writing tests" />);

    const bar = screen.getByRole('progressbar', {name: 'Writing tests'});
    expect(bar).toHaveAttribute('aria-valuenow', '42');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
    expect(screen.getByText('Writing tests')).toBeInTheDocument();
    expect(screen.getByText('42%')).toBeInTheDocument();
  });

  it('scales the fill to the value', () => {
    render(<ProgressBar value={42} label="Writing tests" />);

    const fill = screen.getByRole('progressbar').querySelector('[data-progress-fill]');
    expect(fill).toHaveStyle({width: '42%'});
  });

  it('renders nothing but the track at 0', () => {
    render(<ProgressBar value={0} label="Waiting to start" />);

    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '0');
    expect(bar.querySelector('[data-progress-fill]')).toBeNull();
    expect(screen.getByText('Waiting to start')).toBeInTheDocument();
  });

  it('clamps values outside 0-100', () => {
    const {rerender} = render(<ProgressBar value={140} label="Over" />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');

    rerender(<ProgressBar value={-12} label="Under" />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  });

  it('names the bar even without a visible label', () => {
    render(<ProgressBar value={10} />);

    expect(screen.getByRole('progressbar', {name: 'Progress'})).toBeInTheDocument();
  });
});
