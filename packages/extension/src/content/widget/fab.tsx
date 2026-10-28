import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { getFabPos, setFabPos, hideHost } from "./per-site";
import { rpc } from "@/sidepanel/rpc";
import { unmountWidget } from "./lifecycle";
import { getWidgetTabInfo } from "./tab-info";

type Props = {
  onToggle: () => void;
  active: boolean; // panel open?
};

const DEFAULT_POS = { x: -1, y: -1 }; // sentinel: right/bottom 16px
const FAB_SIZE_PX = 48;

export function FAB({ onToggle, active }: Props) {
  const [pos, setPos] = useState(DEFAULT_POS);
  const [menu, setMenu] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null);
  const movedRef = useRef(false);

  useEffect(() => {
    getFabPos(location.host).then((p) => { if (p) setPos(p); });
  }, []);

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    movedRef.current = false;
    dragRef.current = { startX: e.clientX, startY: e.clientY, ox: pos.x, oy: pos.y };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    if (Math.abs(dx) + Math.abs(dy) > 4) movedRef.current = true;
    if (movedRef.current) {
      setPos({
        x: (dragRef.current.ox === -1 ? window.innerWidth - 64 : dragRef.current.ox) + dx,
        y: (dragRef.current.oy === -1 ? window.innerHeight - 64 : dragRef.current.oy) + dy,
      });
    }
  }

  function onPointerUp(_e: React.PointerEvent) {
    if (dragRef.current && movedRef.current) {
      setFabPos(location.host, pos).catch(() => {});
    } else if (dragRef.current) {
      onToggle();
    }
    dragRef.current = null;
  }

  function onContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    setMenu(true);
  }

  const style: React.CSSProperties =
    pos.x === -1 ? { right: 16, bottom: 16 } : { left: pos.x, top: pos.y };

  return (
    <div style={{ position: "fixed", zIndex: 2147483646, ...style }}>
      <button
        ref={btnRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onContextMenu={onContextMenu}
        aria-label="AIPageGo 助手"
        // Tailwind's `w-12`/`h-12` utilities are expressed in `rem`.  `rem`
        // resolves against the host page's `<html>` font size even inside a
        // shadow root, and mobile pages commonly set that size to 100px+.
        // Keep the injected control a stable 48px regardless of the page.
        style={{ width: FAB_SIZE_PX, height: FAB_SIZE_PX }}
        className={
          "w-12 h-12 rounded-full flex items-center justify-center shadow-lg cursor-pointer " +
          (active
            ? "bg-emerald-600 text-white"
            : "bg-zinc-800 text-emerald-400 border border-zinc-700")
        }
      >
        <Sparkles size={20} />
      </button>
      {menu && (
        <div
          className="absolute right-0 mt-2 bg-zinc-900 border border-zinc-700 rounded shadow-xl text-xs min-w-[180px]"
          onMouseLeave={() => setMenu(false)}
        >
          <button
            className="block w-full text-left px-3 py-2 hover:bg-zinc-800"
            onClick={() => {
              setPos(DEFAULT_POS);
              setFabPos(location.host, DEFAULT_POS).catch(() => {});
              setMenu(false);
            }}
          >
            拖回默认位置
          </button>
          <button
            className="block w-full text-left px-3 py-2 hover:bg-zinc-800"
            onClick={async () => {
              try {
                const { tabId } = await getWidgetTabInfo();
                await rpc.widgetOpenSidepanel({ tabId });
              } catch (e) {
                console.warn("[aipagego-widget] openSidepanel failed:", e);
              }
              setMenu(false);
            }}
          >
            打开扩展面板
          </button>
          <button
            className="block w-full text-left px-3 py-2 hover:bg-zinc-800 text-amber-400"
            onClick={async () => {
              await hideHost(location.hostname);
              unmountWidget();
            }}
          >
            本站不再显示
          </button>
        </div>
      )}
    </div>
  );
}
