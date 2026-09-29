"use client";

import { useState, useEffect } from 'react';
import Battlefield from '../components/Battlefield';
import { Board, Ship, GamePhase } from '../types/game';
import { createEmptyBoard, generateRandomBoard, checkShipSunkAndMark } from '../utils/gameHelpers';

export default function Home() {
  const [phase, setPhase] = useState<GamePhase>('placement');
  
  const [playerBoard, setPlayerBoard] = useState<Board>(createEmptyBoard());
  const [playerShips, setPlayerShips] = useState<Ship[]>([]);
  
  const [enemyBoard, setEnemyBoard] = useState<Board>(createEmptyBoard());
  const [enemyShips, setEnemyShips] = useState<Ship[]>([]);
  
  const [isPlayerTurn, setIsPlayerTurn] = useState<boolean>(true);
  const [winner, setWinner] = useState<'player' | 'enemy' | null>(null);

  useEffect(() => {
    handleRandomize();
  }, []);

  const handleRandomize = () => {
    const pData = generateRandomBoard();
    setPlayerBoard(pData.board);
    setPlayerShips(pData.ships);
  };

  const startGame = () => {
    const eData = generateRandomBoard();
    setEnemyBoard(eData.board);
    setEnemyShips(eData.ships);
    setPhase('playing');
    setIsPlayerTurn(true);
    setWinner(null);
  };

  // Функция для возврата к новой расстановке
  const restartPlacement = () => {
    setEnemyBoard(createEmptyBoard());
    setEnemyShips([]);
    setWinner(null);
    handleRandomize();
    setPhase('placement');
  }; 
  // Проверка победы
  const checkWinCondition = (currentShips: Ship[]) => {
    return currentShips.every(s => s.isSunk);
  };

  // Выстрел игрока по врагу
  const handlePlayerFire = (x: number, y: number) => {
    if (phase !== 'playing' || !isPlayerTurn || winner) return;
    const cell = enemyBoard[y][x];
    if (cell === 'miss' || cell === 'hit' || cell === 'sunk') return;

    const newBoard = [...enemyBoard.map(row => [...row])];
    let newShips = [...enemyShips];

    if (cell === 'ship') {
      newBoard[y][x] = 'hit';
      const result = checkShipSunkAndMark(newBoard, newShips, x, y);
      newShips = result.ships;
      
      setEnemyBoard(newBoard);
      setEnemyShips(newShips);

      // Проверяем победу игрока
      if (checkWinCondition(newShips)) {
        setWinner('player');
        setPhase('game_over');
      }
      // Попал — ходит снова
    } else {
      newBoard[y][x] = 'miss';
      setEnemyBoard(newBoard);
      setIsPlayerTurn(false); // Промазал — ход бота
    }
  };

  // Ход бота (умный поиск вокруг попаданий)
  useEffect(() => {
    if (phase === 'playing' && !isPlayerTurn && !winner) {
      const botTimer = setTimeout(() => {
        let fired = false;
        const newBoard = [...playerBoard.map(row => [...row])];
        let newShips = [...playerShips];
        
        while (!fired) {
          // Ищем раненую, но не потопленную палубу на поле игрока (уровень "Сильный": бот добивает)
          let target: { x: number, y: number } | null = null;
          
          for (let y = 0; y < 10; y++) {
            for (let x = 0; x < 10; x++) {
              if (newBoard[y][x] === 'hit') {
                // Проверяем, жив ли корабль на этой клетке
                const ship = newShips.find(s => s.positions.some(p => p.x === x && p.y === y));
                if (ship && !ship.isSunk) {
                  // Ищем соседнюю пустую или корабельную клетку для добивания
                  const offsets = [{dx:0, dy:1}, {dx:0, dy:-1}, {dx:1, dy:0}, {dx:-1, dy:0}];
                  for (const off of offsets) {
                    const nx = x + off.dx;
                    const ny = y + off.dy;
                    if (nx >= 0 && nx < 10 && ny >= 0 && ny < 10) {
                      if (newBoard[ny][nx] === 'empty' || newBoard[ny][nx] === 'ship') {
                        target = { x: nx, y: ny };
                        break;
                      }
                    }
                  }
                }
              }
              if (target) break;
            }
            if (target) break;
          }

          // Если раненых нет — бьем случайно
          const x = target ? target.x : Math.floor(Math.random() * 10);
          const y = target ? target.y : Math.floor(Math.random() * 10);
          const cell = newBoard[y][x];

          if (cell !== 'miss' && cell !== 'hit' && cell !== 'sunk') {
            if (cell === 'ship') {
              newBoard[y][x] = 'hit';
              const result = checkShipSunkAndMark(newBoard, newShips, x, y);
              newShips = result.ships;
              
              setPlayerBoard(newBoard);
              setPlayerShips(newShips);

              if (checkWinCondition(newShips)) {
                setWinner('enemy');
                setPhase('game_over');
              }
              // Бот попал — продолжает ходить
            } else {
              newBoard[y][x] = 'miss';
              setPlayerBoard(newBoard);
              setIsPlayerTurn(true); // Бот промазал — ход тебе
            }
            fired = true;
          }
        }
      }, 800);
      return () => clearTimeout(botTimer);
    }
  }, [isPlayerTurn, phase, playerBoard, playerShips, winner]);

  const getMaskedEnemyBoard = () => {
    return enemyBoard.map(row => 
      row.map(cell => cell === 'ship' ? 'empty' : cell)
    );
  };

  return (
    <main className="min-h-screen bg-slate-950 text-white flex flex-col items-center py-10 px-4 font-sans">
      <h1 className="text-4xl font-bold mb-6 text-blue-400 tracking-widest uppercase drop-shadow-[0_0_15px_rgba(96,165,250,0.5)]">
        Sonar.io
      </h1>

      {/* Экран расстановки */}
      {phase === 'placement' && (
        <div className="flex flex-col items-center">
          <div className="mb-8 flex gap-4">
            <button onClick={handleRandomize} className="px-6 py-2 bg-white/10 hover:bg-white/20 border border-white/20 rounded-lg font-semibold transition-all">
              🎲 Перемешать
            </button>
            <button onClick={startGame} className="px-6 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg font-semibold transition-all shadow-[0_0_15px_rgba(37,99,235,0.5)]">
              🚀 В бой!
            </button>
          </div>
          <h2 className="mb-4 text-slate-400 font-mono text-sm uppercase tracking-wider">Твой флот</h2>
          <Battlefield board={playerBoard} onCellClick={() => {}} />
        </div>
      )}

      {/* Экран игры */}
      {phase === 'playing' && (
        <div className="flex flex-col items-center w-full max-w-5xl">
          <div className="mb-8 px-6 py-2 bg-white/5 rounded-full border border-white/10">
            <span className={`font-mono font-bold ${isPlayerTurn ? 'text-green-400' : 'text-red-400 animate-pulse'}`}>
              {isPlayerTurn ? '>>> ТВОЙ ХОД' : '!!! ВРАГ ЦЕЛИТСЯ...'}
            </span>
          </div>
          
          <div className="flex flex-col lg:flex-row gap-8 lg:gap-16 w-full justify-center items-center">
            <div className="flex flex-col items-center">
              <h2 className="mb-4 text-red-400 font-mono text-sm uppercase tracking-wider">Радар (Враг)</h2>
              <div className={!isPlayerTurn ? 'opacity-50 pointer-events-none' : ''}>
                <Battlefield board={getMaskedEnemyBoard()} onCellClick={handlePlayerFire} />
              </div>
            </div>

            <div className="flex flex-col items-center">
              <h2 className="mb-4 text-slate-400 font-mono text-sm uppercase tracking-wider">База (Твой флот)</h2>
              <div className="opacity-80 pointer-events-none">
                <Battlefield board={playerBoard} onCellClick={() => {}} />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Экран окончания игры */}
      {phase === 'game_over' && (
        <div className="flex flex-col items-center justify-center p-8 bg-white/5 backdrop-blur-md border border-white/10 rounded-2xl shadow-2xl">
          <h2 className={`text-3xl font-bold mb-4 uppercase tracking-widest ${winner === 'player' ? 'text-green-400' : 'text-red-500'}`}>
            {winner === 'player' ? '🏆 Победа!' : '💀 Поражение флота'}
          </h2>
          <p className="text-slate-400 mb-6">
            {winner === 'player' ? 'Весь вражеский флот отправлен на дно.' : 'Соперник оказался быстрее и точнее.'}
          </p>
          <button onClick={restartPlacement} className="px-8 py-3 bg-blue-600 hover:bg-blue-500 rounded-lg font-semibold transition-all shadow-[0_0_20px_rgba(37,99,235,0.6)]">
            🔄 Новая игра
          </button>
        </div>
      )}
    </main>
  );
}