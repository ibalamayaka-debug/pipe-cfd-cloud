import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './index.css';

class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: 32,
            color: '#f8fafc',
            background: '#070b14',
            height: '100vh',
            fontFamily: 'monospace',
          }}
        >
          <h2 style={{ color: '#f87171' }}>PipeCFD 渲染异常</h2>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#cbd5e1' }}>
            {this.state.error.message}
            {'\n\n'}
            {this.state.error.stack}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

// Note: Avoid React.StrictMode double mount/unmount of WebGL contexts in dev mode.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <RootErrorBoundary>
    <App />
  </RootErrorBoundary>
);
