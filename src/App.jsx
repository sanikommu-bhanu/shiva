/*
 * App.jsx — mounting and teardown only.
 *
 * The React tree owns nothing the viewer sees during playback: a canvas, a
 * hairline preloader while the source frames are being classified, and one
 * whispered keyboard hint that leaves for good the first time it is heard.
 */

import React, { useEffect, useRef, useState } from 'react';
import Experience from './experience/Experience.js';

export default function App() {
  const canvasRef = useRef(null);
  const experienceRef = useRef(null);
  const [progress, setProgress] = useState(0);
  const [ready, setReady] = useState(false);
  const [hintGone, setHintGone] = useState(false);

  useEffect(() => {
    const experience = new Experience(canvasRef.current, {
      onProgress: setProgress,
    });
    experienceRef.current = experience;
    experience.load().then(() => setReady(true));
    if (location.search.includes('debug')) window.__om = experience;

    const onKey = (e) => {
      if (e.code !== 'Space') return;
      e.preventDefault();
      setHintGone(true);
      experienceRef.current?.replay();
    };
    window.addEventListener('keydown', onKey);

    return () => {
      window.removeEventListener('keydown', onKey);
      experience.dispose();
      experienceRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!ready) return undefined;
    const t = setTimeout(() => setHintGone(true), 9000);
    return () => clearTimeout(t);
  }, [ready]);

  return (
    <>
      <style>{css}</style>
      <canvas ref={canvasRef} className="stage" />
      <div className={`preloader${ready ? ' gone' : ''}`}>
        <div className="preloader-line" style={{ transform: `scaleX(${progress})` }} />
      </div>
      <div className={`hint${ready && !hintGone ? ' shown' : ''}`}>space</div>
    </>
  );
}

const css = `
.stage {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}

.preloader {
  position: fixed;
  left: 50%;
  top: 50%;
  width: 96px;
  height: 1px;
  margin: 0 0 0 -48px;
  background: rgba(255, 255, 255, 0.09);
  transition: opacity 900ms ease;
  pointer-events: none;
}
.preloader.gone { opacity: 0; }
.preloader-line {
  width: 100%;
  height: 100%;
  background: rgba(255, 255, 255, 0.55);
  transform-origin: 0 50%;
  transition: transform 400ms ease;
}

.hint {
  position: fixed;
  left: 50%;
  bottom: 34px;
  transform: translateX(-50%);
  font: 400 10px/1 ui-sans-serif, system-ui, sans-serif;
  letter-spacing: 0.42em;
  text-transform: lowercase;
  color: rgba(255, 255, 255, 0.22);
  opacity: 0;
  transition: opacity 1600ms ease;
  pointer-events: none;
  user-select: none;
}
.hint.shown { opacity: 1; }
`;
