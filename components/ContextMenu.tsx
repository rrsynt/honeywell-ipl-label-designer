
import React, { useEffect, useRef } from 'react';

export type ContextMenuOption =
  | {
      label: string;
      action: () => void;
      disabled?: boolean;
      separator?: undefined; // Explicitly make separator undefined for item type
    }
  | {
      separator: true;
      label?: never;
      action?: never;
      disabled?: never;
    };

interface ContextMenuProps {
  x: number;
  y: number;
  options: ContextMenuOption[];
  onClose: () => void;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, options, onClose }) => {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if ( (event.button !== 2) && menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const handleContextMenuOutside = (event: MouseEvent) => {
       if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    }
    
    // Deferred so the same right-click that opened the menu doesn't close it
    // again — but the handle MUST be cancellable: unmounting before the timer
    // fires used to leave both listeners bound to document forever.
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('contextmenu', handleContextMenuOutside);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('contextmenu', handleContextMenuOutside);
    };
  }, [onClose]);

  const menuStyle: React.CSSProperties = {
    top: `${y}px`,
    left: `${x}px`,
    position: 'fixed',
    zIndex: 1000,
  };

  return (
    <div ref={menuRef} style={menuStyle} className="bg-gray-800 border border-gray-600 rounded-md shadow-lg py-1 w-48 animate-fade-in-fast">
      {options.map((option, index) => {
        if (option.separator) {
          return <div key={`sep-${index}`} className="h-px bg-gray-600 my-1" />;
        }
        return (
          <button
            key={option.label}
            onClick={(e) => {
              e.stopPropagation();
              option.action();
              onClose();
            }}
            disabled={option.disabled}
            className="w-full text-left px-3 py-1.5 text-sm text-gray-200 hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
};

const style = document.createElement('style');
style.innerHTML = `
  @keyframes fadeInFast {
    from { opacity: 0; transform: scale(0.95); }
    to { opacity: 1; transform: scale(1); }
  }
  .animate-fade-in-fast {
    animation: fadeInFast 0.1s ease-out forwards;
  }
`;
document.head.appendChild(style);
