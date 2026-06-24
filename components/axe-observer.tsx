'use client';

// Loads @axe-core/react in development only so axe violations appear in the
// browser console.  The import is dynamic so axe is never bundled for production.
// Usage: render <AxeObserver /> once, high in the React tree (e.g. layout.tsx).

import { useEffect } from 'react';

export function AxeObserver() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;

    let cleanup: (() => void) | undefined;

    import('@axe-core/react').then(({ default: axe }) => {
      const React = require('react');
      const ReactDOM = require('react-dom');
      axe(React, ReactDOM, 1000);
      // @axe-core/react does not expose an unsubscribe API, so we leave it running.
    });

    return cleanup;
  }, []);

  return null;
}
