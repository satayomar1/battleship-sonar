"use client";

import React from 'react';
import { CellState } from '../types/game';

interface BattlefieldProps {
  board: CellState[][];
  onCellClick: (x: number, y: number) => void;
}

export default function Battlefield({ board, onCellClick }: BattlefieldProps) {
  return (
    <div className="bg-white/5 backdrop-blur-md border border-white/10 rounded-xl p-4 shadow-[0_0_30px_rgba(0,0,0,0.5)] inline-block">
      {/* Сетка 10x10. Размер адаптивный: на мобилке 300px, на ПК 400px */}
      <div className="grid grid-cols-10 gap-1 w-[300px] h-[300px] sm:w-[400px] sm:h-[400px]">
        {board.map((row, y) =>
          row.map((cell, x) => {
            // Визуал в зависимости от состояния клетки
            let cellStyle = "bg-transparent"; 
            let innerContent = null;

            if (cell === 'ship') {
              cellStyle = "bg-blue-500/50 border-blue-400 shadow-[0_0_10px_rgba(59,130,246,0.5)]";
            } else if (cell === 'miss') {
              // Серая точка
              innerContent = <div className="w-2 h-2 rounded-full bg-slate-500"></div>;
            } else if (cell === 'hit') {
              // Попадание
              cellStyle = "bg-red-500/40 border-red-400";
              innerContent = <div className="text-red-400 text-xl font-bold leading-none">×</div>;
            } else if (cell === 'sunk') {
              // Потоплен
              cellStyle = "bg-red-700/60 border-red-500";
              innerContent = <div className="text-white text-xl font-bold leading-none opacity-80">×</div>;
            }

            return (
              <div
                key={`${y}-${x}`}
                onClick={() => onCellClick(x, y)}
                className={`
                  border border-white/10 aspect-square rounded-sm 
                  flex items-center justify-center cursor-pointer 
                  hover:bg-white/20 hover:border-white/30 transition-all duration-200
                  ${cellStyle}
                `}
              >
                {innerContent}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}