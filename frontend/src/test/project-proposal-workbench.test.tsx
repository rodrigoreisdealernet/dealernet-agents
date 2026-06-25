/**
 * Tests for /rental/project-proposal — Project Proposal Workbench route
 *
 * Tests cover:
 *  - Route-level canWrite gate (admin / branch_manager vs read-only roles)
 *  - Access-denied state rendered for unauthorized direct navigation
 *  - Workbench screen testid rendered for authorized roles
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AppRole } from '@/auth/types';

// ---------------------------------------------------------------------------
// Hoist mocks before module imports
// ---------------------------------------------------------------------------

const { capabilitiesState } = vi.hoisted(() => ({
  capabilitiesState: { canWrite: true, canOperate: true, role: 'admin' as AppRole },
}));

vi.mock('@/auth/AuthContext', () => ({
  useAuthCapabilities: () => capabilitiesState,
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');
  return {
    ...actual,
    createFileRoute: () => () => ({
      useSearch: () => ({ customer: '%', category: '%', branch: '%' }),
      fullPath: '/rental/project-proposal',
    }),
    useNavigate: () => vi.fn(),
  };
});

// UIEngine renders arbitrary page definitions; stub it to a lightweight div
// so tests stay fast and focused on the route-level capability guard.
vi.mock('@/engine', () => ({
  UIEngine: () => <div data-testid="ui-engine-stub" />,
}));

import {
  ProjectProposalWorkbenchPage,
  ProjectProposalWorkbenchScreen,
} from '@/routes/rental/project-proposal';

// ---------------------------------------------------------------------------
// Role-gating tests — exercises the real ProductProposalWorkbenchPage guard
// ---------------------------------------------------------------------------

describe('ProjectProposalWorkbenchPage — route-level role gate', () => {
  beforeEach(() => {
    capabilitiesState.canWrite = true;
    capabilitiesState.canOperate = true;
    capabilitiesState.role = 'admin';
  });

  it('renders workbench screen for admin', () => {
    render(<ProjectProposalWorkbenchPage />);
    expect(screen.getByTestId('project-proposal-workbench-screen')).toBeInTheDocument();
    expect(screen.queryByTestId('project-proposal-access-denied')).not.toBeInTheDocument();
  });

  it('renders workbench screen for branch_manager', () => {
    capabilitiesState.canWrite = true;
    capabilitiesState.role = 'branch_manager';
    render(<ProjectProposalWorkbenchPage />);
    expect(screen.getByTestId('project-proposal-workbench-screen')).toBeInTheDocument();
    expect(screen.queryByTestId('project-proposal-access-denied')).not.toBeInTheDocument();
  });

  it('renders access-denied for field_operator', () => {
    capabilitiesState.canWrite = false;
    capabilitiesState.canOperate = true;
    capabilitiesState.role = 'field_operator';
    render(<ProjectProposalWorkbenchPage />);
    expect(screen.getByTestId('project-proposal-access-denied')).toBeInTheDocument();
    expect(screen.queryByTestId('project-proposal-workbench-screen')).not.toBeInTheDocument();
  });

  it('renders access-denied for read_only', () => {
    capabilitiesState.canWrite = false;
    capabilitiesState.canOperate = false;
    capabilitiesState.role = 'read_only';
    render(<ProjectProposalWorkbenchPage />);
    expect(screen.getByTestId('project-proposal-access-denied')).toBeInTheDocument();
    expect(screen.queryByTestId('project-proposal-workbench-screen')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Screen testid presence
// ---------------------------------------------------------------------------

describe('ProjectProposalWorkbenchScreen — testid', () => {
  it('wraps content with project-proposal-workbench-screen testid', () => {
    render(<ProjectProposalWorkbenchScreen />);
    expect(screen.getByTestId('project-proposal-workbench-screen')).toBeInTheDocument();
  });
});