import { describe, it, expect } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { HealthBar } from '../health-bar';

// ---------------------------------------------------------------------------
// HealthBar component tests
// ---------------------------------------------------------------------------

describe('HealthBar', () => {
  // ---------------------------------------------------------------------------
  // Basic rendering
  // ---------------------------------------------------------------------------

  it('renders without label when label is not provided', () => {
    const { container } = render(<HealthBar value={50} max={100} />);
    // Should still render the fill bar
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with a label when provided', () => {
    render(<HealthBar value={50} max={100} label="Hull" />);
    expect(screen.getByText('Hull')).toBeInTheDocument();
  });

  it('displays value/max text', () => {
    render(<HealthBar value={50} max={100} label="Hull" />);
    expect(screen.getByText('50/100')).toBeInTheDocument();
  });

  it('renders with zero value', () => {
    render(<HealthBar value={0} max={100} label="Fuel" />);
    expect(screen.getByText('0/100')).toBeInTheDocument();
  });

  it('renders at full max value', () => {
    render(<HealthBar value={100} max={100} label="HP" />);
    expect(screen.getByText('100/100')).toBeInTheDocument();
  });

  it('renders when max is zero (edge case)', () => {
    // pct should be 0, not NaN
    const { container } = render(<HealthBar value={0} max={0} label="Test" />);
    expect(container.firstChild).toBeTruthy();
    expect(screen.getByText('0/0')).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Fill bar percentage
  // ---------------------------------------------------------------------------

  it('sets fill bar width to correct percentage', () => {
    const { container } = render(<HealthBar value={75} max={100} />);
    const fillBar = container.querySelector('[style*="width"]') as HTMLElement;
    expect(fillBar).toBeTruthy();
    expect(fillBar.style.width).toBe('75%');
  });

  it('caps fill bar at 100% when value exceeds max', () => {
    const { container } = render(<HealthBar value={150} max={100} />);
    const fillBar = container.querySelector('[style*="width"]') as HTMLElement;
    expect(fillBar.style.width).toBe('100%');
  });

  it('shows 0% fill when value is 0', () => {
    const { container } = render(<HealthBar value={0} max={100} />);
    const fillBar = container.querySelector('[style*="width"]') as HTMLElement;
    expect(fillBar.style.width).toBe('0%');
  });

  // ---------------------------------------------------------------------------
  // Color thresholds (normal mode)
  // ---------------------------------------------------------------------------

  it('uses success color when percentage > 60%', () => {
    const { container } = render(<HealthBar value={80} max={100} />);
    const fillBar = container.querySelector('[style*="width"]') as HTMLElement;
    expect(fillBar.className).toContain('bg-success');
  });

  it('uses warning color when percentage is between 30% and 60%', () => {
    const { container } = render(<HealthBar value={50} max={100} />);
    const fillBar = container.querySelector('[style*="width"]') as HTMLElement;
    expect(fillBar.className).toContain('bg-warning');
  });

  it('uses error color when percentage is below 30%', () => {
    const { container } = render(<HealthBar value={20} max={100} />);
    const fillBar = container.querySelector('[style*="width"]') as HTMLElement;
    expect(fillBar.className).toContain('bg-error');
  });

  it('uses success color at exactly 61%', () => {
    const { container } = render(<HealthBar value={61} max={100} />);
    const fillBar = container.querySelector('[style*="width"]') as HTMLElement;
    expect(fillBar.className).toContain('bg-success');
  });

  it('uses warning color at exactly 60%', () => {
    const { container } = render(<HealthBar value={60} max={100} />);
    const fillBar = container.querySelector('[style*="width"]') as HTMLElement;
    // pct = 60, not > 60, not > 30 → warning
    expect(fillBar.className).toContain('bg-warning');
  });

  it('uses error color at exactly 30%', () => {
    const { container } = render(<HealthBar value={30} max={100} />);
    const fillBar = container.querySelector('[style*="width"]') as HTMLElement;
    // pct = 30, not > 30 → error
    expect(fillBar.className).toContain('bg-error');
  });

  // ---------------------------------------------------------------------------
  // Inverted mode (high is bad, low is good — e.g. cargo)
  // ---------------------------------------------------------------------------

  it('inverts colors: error when percentage > 80%', () => {
    const { container } = render(<HealthBar value={90} max={100} invert />);
    const fillBar = container.querySelector('[style*="width"]') as HTMLElement;
    expect(fillBar.className).toContain('bg-error');
  });

  it('inverts colors: warning when percentage 50-80%', () => {
    const { container } = render(<HealthBar value={60} max={100} invert />);
    const fillBar = container.querySelector('[style*="width"]') as HTMLElement;
    expect(fillBar.className).toContain('bg-warning');
  });

  it('inverts colors: success when percentage ≤ 50%', () => {
    const { container } = render(<HealthBar value={30} max={100} invert />);
    const fillBar = container.querySelector('[style*="width"]') as HTMLElement;
    expect(fillBar.className).toContain('bg-success');
  });

  // ---------------------------------------------------------------------------
  // Size variants
  // ---------------------------------------------------------------------------

  it('applies thin track height for size="sm"', () => {
    const { container } = render(<HealthBar value={50} max={100} size="sm" />);
    const track = container.querySelector('.h-1\\.5');
    expect(track).toBeTruthy();
  });

  it('applies default track height for size="md"', () => {
    const { container } = render(<HealthBar value={50} max={100} size="md" />);
    const track = container.querySelector('.h-2\\.5');
    expect(track).toBeTruthy();
  });

  it('defaults to size="md" when not specified', () => {
    const { container } = render(<HealthBar value={50} max={100} />);
    const track = container.querySelector('.h-2\\.5');
    expect(track).toBeTruthy();
  });
});
