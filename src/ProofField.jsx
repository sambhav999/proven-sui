import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { ArrowUpRight, Move3D } from 'lucide-react';
import './proof-field.css';

const STAGES = [
  { label: 'Commit', title: 'The forecast is locked.', detail: 'A signed commitment fixes every probability before the cutoff. The answer stays private.', color: '#c1f265' },
  { label: 'Reveal', title: 'The full slate is revealed.', detail: 'After the cutoff, the agent reveals all probabilities and the salt. The commitment must match.', color: '#91ddd1' },
  { label: 'Resolve', title: 'Reality supplies the answer.', detail: 'The operator publishes outcomes with the specified source evidence for every question.', color: '#f6bb81' },
  { label: 'Receipt', title: 'Inspect the evidence.', detail: 'A signed receipt carries the score, baseline, timing and source trail for independent review.', color: '#bbadff' },
];

export default function ProofField({ onVerify }) {
  const mount = useRef(null);
  const sceneState = useRef(null);
  const [stage, setStage] = useState(0);
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    const host = mount.current;
    if (!host) return;
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
    } catch {
      setFallback(true);
      return;
    }
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(37, 1, .1, 100);
    camera.position.set(0, .15, 9.2);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.className = 'proof-canvas';
    renderer.domElement.setAttribute('aria-hidden', 'true');
    host.appendChild(renderer.domElement);

    const group = new THREE.Group();
    scene.add(group);
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(1.55, 3), new THREE.MeshPhysicalMaterial({
      color: 0x99c36e, metalness: .22, roughness: .28, transparent: true, opacity: .25,
      flatShading: true, side: THREE.DoubleSide, depthWrite: false,
    }));
    const lattice = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1.55, 2)),
      new THREE.LineBasicMaterial({ color: 0xbaf064, transparent: true, opacity: .3 }));
    const inner = new THREE.Mesh(new THREE.IcosahedronGeometry(.76, 2), new THREE.MeshBasicMaterial({ color: 0xbaf064, wireframe: true, transparent: true, opacity: .42 }));
    group.add(core, lattice, inner);
    const rings = [0, 1, 2].map((_, i) => {
      const mesh = new THREE.Mesh(new THREE.TorusGeometry(2.15 + i * .21, .009, 4, 112),
        new THREE.MeshBasicMaterial({ color: i === 1 ? 0x91ddd1 : 0x8caa78, transparent: true, opacity: .26 }));
      mesh.rotation.set(.7 + i * .62, .28 + i * .76, i * .4);
      group.add(mesh);
      return mesh;
    });

    // The four clickable beacons represent the same stages as the accessible controls below.
    const positions = [[-2.45, 1.65, .5], [2.4, 1.65, .4], [-2.4, -1.65, .4], [2.45, -1.65, .5]];
    const beacons = positions.map((p, i) => {
      const tint = new THREE.Color(STAGES[i].color);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(...p), new THREE.Vector3(p[0] * .43, p[1] * .43, 0),
      ]), new THREE.LineBasicMaterial({ color: tint, transparent: true, opacity: .36 }));
      const dot = new THREE.Mesh(new THREE.SphereGeometry(.18, 16, 12),
        new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: .9 }));
      const halo = new THREE.Mesh(new THREE.RingGeometry(.25, .28, 32),
        new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: .45, side: THREE.DoubleSide }));
      dot.position.set(...p); halo.position.set(...p);
      dot.userData.stage = i;
      group.add(line, dot, halo);
      return { dot, halo, line };
    });

    const points = new Float32Array(165 * 3);
    let seed = 91;
    const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < 165; i++) {
      const a = random() * Math.PI * 2;
      const r = 2.2 + random() * 1.7;
      points[i * 3] = Math.cos(a) * r;
      points[i * 3 + 1] = (random() - .5) * 4.7;
      points[i * 3 + 2] = Math.sin(a) * r - 1;
    }
    const starsGeometry = new THREE.BufferGeometry();
    starsGeometry.setAttribute('position', new THREE.BufferAttribute(points, 3));
    const stars = new THREE.Points(starsGeometry, new THREE.PointsMaterial({ color: 0xc8eeba, size: .026, transparent: true, opacity: .55 }));
    scene.add(stars);

    const resize = () => {
      const w = Math.max(host.clientWidth, 1), h = Math.max(host.clientHeight, 1);
      camera.aspect = w / h;
      camera.position.z = w < 420 ? 11 : 9.2;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let dragging = false, moved = false, lastX = 0, lastY = 0;
    let visible = true, frame = 0;
    const visibility = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; });
    visibility.observe(host);
    const down = e => { dragging = true; moved = false; lastX = e.clientX; lastY = e.clientY; host.setPointerCapture(e.pointerId); };
    const move = e => {
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      group.rotation.y += dx * .005;
      group.rotation.x = THREE.MathUtils.clamp(group.rotation.x + dy * .003, -.65, .65);
      lastX = e.clientX; lastY = e.clientY;
    };
    const up = e => {
      if (!dragging) return;
      dragging = false;
      if (host.hasPointerCapture(e.pointerId)) host.releasePointerCapture(e.pointerId);
      if (moved) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set((e.clientX - rect.left) / rect.width * 2 - 1, -(e.clientY - rect.top) / rect.height * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(beacons.map(b => b.dot));
      if (hits.length) setStage(hits[0].object.userData.stage);
    };
    const lost = e => { e.preventDefault(); setFallback(true); };
    host.addEventListener('pointerdown', down);
    host.addEventListener('pointermove', move);
    host.addEventListener('pointerup', up);
    renderer.domElement.addEventListener('webglcontextlost', lost);
    sceneState.current = { core, lattice, inner, beacons, renderer, scene, camera };
    let elapsed = 0;
    const animate = () => {
      frame = requestAnimationFrame(animate);
      if (!visible || document.hidden) return;
      if (!motion.matches) {
        elapsed += .012;
        if (!dragging) group.rotation.y += .0008;
        inner.rotation.y += .003;
        rings.forEach((ring, i) => { ring.rotation.z += (i % 2 ? -1 : 1) * .0005; });
        beacons.forEach((b, i) => { b.halo.scale.setScalar(1 + .12 * Math.sin(elapsed * 1.4 + i)); });
      }
      renderer.render(scene, camera);
    };
    animate();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect(); visibility.disconnect();
      host.removeEventListener('pointerdown', down);
      host.removeEventListener('pointermove', move);
      host.removeEventListener('pointerup', up);
      renderer.domElement.removeEventListener('webglcontextlost', lost);
      scene.traverse(object => {
        object.geometry?.dispose();
        if (object.material) (Array.isArray(object.material) ? object.material : [object.material]).forEach(material => material.dispose());
      });
      renderer.dispose();
      renderer.domElement.remove();
      sceneState.current = null;
    };
  }, []);

  useEffect(() => {
    const state = sceneState.current;
    if (!state) return;
    const color = new THREE.Color(STAGES[stage].color);
    state.core.material.color.copy(color);
    state.lattice.material.color.copy(color);
    state.inner.material.color.copy(color);
    state.beacons.forEach((b, i) => {
      b.dot.scale.setScalar(i === stage ? 1.55 : 1);
      b.halo.material.opacity = i === stage ? .9 : .35;
      b.line.material.opacity = i === stage ? .78 : .25;
    });
  }, [stage, fallback]);

  return <div className="proof-field">
    <div className="proof-top"><span>THE PROOF ENGINE / EXPLORE</span><span><span className="tiny-dot"/> INTERACTIVE ILLUSTRATION</span></div>
    <div className="proof-scene" ref={mount} aria-label="Interactive 3D illustration of the proof stages">
      {fallback && <div className="proof-fallback" role="img" aria-label="Four proof stages connected around a central record"><span>✳</span><i>COMMIT</i><i>REVEAL</i><i>RESOLVE</i><i>RECEIPT</i></div>}
      <div className="proof-scene-label"><span>01 — 04 / EVIDENCE PATH</span><span><Move3D size={13}/> DRAG TO EXPLORE</span></div>
    </div>
    <div className="proof-body"><div className="proof-stage-list" role="group" aria-label="Explore the four proof stages">
      {STAGES.map((item, i) => <button key={item.label} type="button" onClick={() => setStage(i)}
        className={stage === i ? 'proof-stage active' : 'proof-stage'} aria-pressed={stage === i}
        style={{ '--stage-color': item.color }}><span>0{i + 1}</span>{item.label}</button>)}
    </div><div className="proof-stage-copy" role="status" aria-live="polite"><div><small>STEP 0{stage + 1} / {STAGES[stage].label.toUpperCase()}</small><strong>{STAGES[stage].title}</strong><p>{STAGES[stage].detail}</p></div><button type="button" onClick={onVerify} aria-label="Open receipt verifier"><ArrowUpRight size={20}/></button></div></div>
    <div className="proof-bottom"><span>SELECT A STAGE OR ROTATE THE FIELD</span><span>NO SAMPLE IS A VERIFIED FORECAST</span></div>
  </div>;
}
