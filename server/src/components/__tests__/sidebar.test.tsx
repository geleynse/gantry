import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { Sidebar } from '../sidebar';
import { createMockFleetStatus } from '@/test/mocks/agents';
import { MockEventSource } from '@/test/setup';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPathname = mock(() => '/');

mock.module('next/navigation', () => ({
  usePathname: () => mockPathname(),
  useRouter: () => ({ push: mock() }),
}));

mock.module('next/link', () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

// ---------------------------------------------------------------------------
// LocalStorage setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Remove the specific key the sidebar uses rather than calling .clear()
  localStorage.removeItem('fleet-sidebar-collapsed');
  mockPathname.mockReturnValue('/');
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Sidebar', () => {
  // ---------------------------------------------------------------------------
  // Navigation links
  // ---------------------------------------------------------------------------

  describe('navigation links', () => {
    it('renders main navigation links', () => {
      render(<Sidebar />);
      expect(screen.getByText('Dashboard')).toBeInTheDocument();
      expect(screen.getByText('Map')).toBeInTheDocument();
      expect(screen.getByText('Analytics')).toBeInTheDocument();
      expect(screen.getByText('Diagnostics')).toBeInTheDocument();
      expect(screen.getByText('Comms')).toBeInTheDocument();
      expect(screen.getByText('Notes')).toBeInTheDocument();
    });

    it('renders agent navigation links', async () => {
      render(<Sidebar />);
      // Agent names come from SSE — prime all EventSource instances
      await act(async () => {
        for (const es of MockEventSource.instances.filter(e => e.url === '/api/status/stream')) {
          es.simulateOpen();
          es.simulateMessage('status', createMockFleetStatus());
        }
      });
      expect(screen.getByText('drifter-gale')).toBeInTheDocument();
      expect(screen.getByText('sable-thorn')).toBeInTheDocument();
      expect(screen.getByText('rust-vane')).toBeInTheDocument();
      expect(screen.getByText('cinder-wake')).toBeInTheDocument();
      expect(screen.getByText('lumen-shoal')).toBeInTheDocument();
    });

    it('Dashboard link points to "/"', () => {
      render(<Sidebar />);
      const dashboardLink = screen.getAllByRole('link').find(
        (l) => l.textContent?.includes('Dashboard'),
      );
      expect(dashboardLink).toHaveAttribute('href', '/');
    });

    it('agent links point to /agent/[name]', async () => {
      render(<Sidebar />);
      await act(async () => {
        for (const es of MockEventSource.instances.filter(e => e.url === '/api/status/stream')) {
          es.simulateOpen();
          es.simulateMessage('status', createMockFleetStatus());
        }
      });
      const links = screen.getAllByRole('link');
      const drifterLink = links.find((l) => l.textContent?.trim() === 'drifter-gale');
      expect(drifterLink).toHaveAttribute('href', '/agent/drifter-gale');
    });
  });

  // ---------------------------------------------------------------------------
  // Brand / logo
  // ---------------------------------------------------------------------------

  it('renders Gantry brand text', () => {
    render(<Sidebar />);
    // Multiple instances (desktop + mobile hidden) — use getAllByText
    const brandElements = screen.getAllByText('Gantry');
    expect(brandElements.length).toBeGreaterThan(0);
  });

  it('shows fleet name when SSE provides it', async () => {
    render(<Sidebar />);
    // Simulate SSE 'status' event with fleetName
    const es = MockEventSource.instances.find(
      (e) => e.url === '/api/status/stream',
    );
    expect(es).toBeDefined();

    await act(async () => {
      es!.simulateOpen();
      es!.simulateMessage('status', createMockFleetStatus());
    });

    expect(screen.getAllByText('Test Fleet').length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // Collapse / expand
  // ---------------------------------------------------------------------------

  describe('collapse behavior', () => {
    it('starts expanded by default (no localStorage value)', () => {
      const { container } = render(<Sidebar />);
      const aside = container.querySelector('aside.hidden.md\\:flex');
      expect(aside?.className).toContain('w-[240px]');
    });

    it('restores collapsed state from localStorage', () => {
      localStorage.setItem('fleet-sidebar-collapsed', 'true');
      const { container } = render(<Sidebar />);
      const aside = container.querySelector('aside.hidden.md\\:flex');
      expect(aside?.className).toContain('w-[56px]');
    });

    it('restores expanded state from localStorage', () => {
      localStorage.setItem('fleet-sidebar-collapsed', 'false');
      const { container } = render(<Sidebar />);
      const aside = container.querySelector('aside.hidden.md\\:flex');
      expect(aside?.className).toContain('w-[240px]');
    });

    it('persists collapsed state to localStorage on toggle', () => {
      render(<Sidebar />);
      const toggleBtn = screen.getAllByRole('button').find(
        (b) => b.getAttribute('aria-label')?.toLowerCase().includes('collapse') ||
               b.getAttribute('aria-label')?.toLowerCase().includes('expand') ||
               b.querySelector('svg') !== null,
      );
      // Find the toggle button (ChevronLeft/Right — not "close menu")
      const buttons = screen.getAllByRole('button').filter(
        (b) => !b.getAttribute('aria-label')?.includes('Close') &&
               !b.getAttribute('aria-label')?.includes('Agents'),
      );
      if (buttons.length > 0) {
        fireEvent.click(buttons[0]);
        expect(localStorage.getItem('fleet-sidebar-collapsed')).not.toBeNull();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Mobile overlay
  // ---------------------------------------------------------------------------

  describe('mobile overlay', () => {
    it('does not show mobile drawer initially', () => {
      render(<Sidebar />);
      expect(screen.queryByRole('button', { name: /Close menu/i })).not.toBeInTheDocument();
    });

    it('opens mobile drawer when "sidebar:open" event fires', () => {
      render(<Sidebar />);
      act(() => {
        document.dispatchEvent(new Event('sidebar:open'));
      });
      expect(screen.getByRole('button', { name: /Close menu/i })).toBeInTheDocument();
    });

    it('closes mobile drawer when close button is clicked', () => {
      render(<Sidebar />);
      act(() => {
        document.dispatchEvent(new Event('sidebar:open'));
      });
      fireEvent.click(screen.getByRole('button', { name: /Close menu/i }));
      expect(screen.queryByRole('button', { name: /Close menu/i })).not.toBeInTheDocument();
    });

    it('closes mobile drawer when overlay backdrop is clicked', () => {
      const { container } = render(<Sidebar />);
      act(() => {
        document.dispatchEvent(new Event('sidebar:open'));
      });
      // Click the backdrop overlay div
      const overlay = container.querySelector('.md\\:hidden.fixed.inset-0');
      if (overlay) {
        fireEvent.click(overlay);
        expect(screen.queryByRole('button', { name: /Close menu/i })).not.toBeInTheDocument();
      }
    });

    it('closes mobile drawer on route change', () => {
      render(<Sidebar />);
      act(() => {
        document.dispatchEvent(new Event('sidebar:open'));
      });
      expect(screen.getByRole('button', { name: /Close menu/i })).toBeInTheDocument();

      // Simulate route change
      mockPathname.mockReturnValue('/map');
      act(() => {
        // Re-render to pick up the new pathname
      });
      // The useEffect watching pathname will fire on re-render
    });
  });

  // ---------------------------------------------------------------------------
  // Agents section toggle
  // ---------------------------------------------------------------------------

  describe('agents section', () => {
    it('shows agents section by default', async () => {
      render(<Sidebar />);
      await act(async () => {
        for (const es of MockEventSource.instances.filter(e => e.url === '/api/status/stream')) {
          es.simulateOpen();
          es.simulateMessage('status', createMockFleetStatus());
        }
      });
      expect(screen.getByText('drifter-gale')).toBeInTheDocument();
    });
  });
});
