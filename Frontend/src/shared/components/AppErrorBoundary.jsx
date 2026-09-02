import { Component } from 'react'

/**
 * Catches render errors so one broken screen does not take the whole app down.
 *
 * React unmounts the entire tree when a render throws and nothing catches it,
 * which is why a single failed route chunk produced a white page with no clue
 * what happened. The admin router lazy-loads 116 routes: when one of those
 * dynamic imports resolves to undefined, reading `.default` off it throws here
 * rather than anywhere the user could act on.
 *
 * A chunk that fails after a deploy is the common case and is fixed by loading
 * the page again, so that gets a button rather than an explanation.
 */
export default class AppErrorBoundary extends Component {
    constructor(props) {
        super(props)
        this.state = { error: null }
    }

    static getDerivedStateFromError(error) {
        return { error }
    }

    componentDidCatch(error, info) {
        // Left as console output on purpose: there is no error reporting service
        // wired up yet, and losing the stack entirely is worse than a log.
        console.error('Unhandled render error:', error, info?.componentStack)
    }

    render() {
        const { error } = this.state
        if (!error) return this.props.children

        // A failed dynamic import is almost always a stale bundle, not a bug in
        // the screen itself, so it is worth saying so plainly.
        const isChunkError = /Loading chunk|dynamically imported module|reading 'default'/i
            .test(String(error?.message || ''))

        return (
            <div style={{
                minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: '24px', fontFamily: 'Poppins, system-ui, sans-serif', background: '#f5f5f5',
            }}>
                <div style={{
                    maxWidth: '520px', width: '100%', background: '#fff', borderRadius: '12px',
                    padding: '32px', boxShadow: '0 1px 3px rgba(0,0,0,.1)', textAlign: 'center',
                }}>
                    <h1 style={{ margin: '0 0 8px', fontSize: '20px', color: '#171717' }}>
                        {isChunkError ? 'This page needs reloading' : 'Something went wrong'}
                    </h1>
                    <p style={{ margin: '0 0 24px', fontSize: '14px', color: '#525252', lineHeight: 1.6 }}>
                        {isChunkError
                            ? 'The app was updated while this tab was open, so part of it could not load. Reloading picks up the new version.'
                            : 'This screen hit an unexpected error. Reloading usually clears it.'}
                    </p>
                    <button
                        type="button"
                        onClick={() => window.location.reload()}
                        style={{
                            background: '#008078', color: '#fff', border: 'none', borderRadius: '8px',
                            padding: '10px 20px', fontSize: '14px', cursor: 'pointer', fontWeight: 500,
                        }}
                    >
                        Reload
                    </button>
                    <details style={{ marginTop: '24px', textAlign: 'left' }}>
                        <summary style={{ fontSize: '12px', color: '#737373', cursor: 'pointer' }}>
                            Technical details
                        </summary>
                        <pre style={{
                            marginTop: '8px', fontSize: '11px', color: '#525252', whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word', background: '#fafafa', padding: '12px', borderRadius: '6px',
                        }}>
                            {String(error?.message || error)}
                        </pre>
                    </details>
                </div>
            </div>
        )
    }
}
