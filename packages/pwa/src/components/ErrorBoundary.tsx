import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * React Error Boundary
 *
 * Catches React rendering crashes and shows error details on screen
 * instead of a blank/black screen.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error('[ErrorBoundary] React crash:', error.message);
    console.error('[ErrorBoundary] Stack:', error.stack);
    if (info.componentStack) {
      console.error('[ErrorBoundary] Component stack:', info.componentStack);
    }
  }

  render() {
    if (this.state.hasError) {
      const { error } = this.state;
      return (
        <div style={{
          minHeight: '100dvh',
          backgroundColor: '#1a1a2e',
          color: '#e0e0e0',
          padding: '24px',
          fontFamily: 'monospace',
          fontSize: '0.875rem',
          overflow: 'auto',
        }}>
          <h1 style={{ color: '#ff6b6b', fontSize: '1.25rem', marginBottom: '16px' }}>
            AegisTalk Crash
          </h1>
          <p style={{ color: '#ffa502', marginBottom: '12px' }}>
            {error?.message || 'Unknown error'}
          </p>
          <pre style={{
            backgroundColor: '#16213e',
            padding: '12px',
            borderRadius: '8px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            fontSize: '0.75rem',
            maxHeight: '60vh',
            overflow: 'auto',
          }}>
            {error?.stack || 'No stack trace'}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: '16px',
              padding: '12px 24px',
              backgroundColor: '#4dd0e1',
              color: '#1a1a2e',
              border: 'none',
              borderRadius: '8px',
              fontSize: '1rem',
              fontWeight: 'bold',
              cursor: 'pointer',
            }}
          >
            Reload App
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
