import { useState, useCallback } from 'react';
import { BASE_URL } from './types';
import type { TimeTask } from './types';

export function useTimetable() {
  const [tasks, setTasks] = useState<TimeTask[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const fetchTasks = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch(`${BASE_URL}/tasks`);
      const data = await res.json();
      if (data.status === 'ok') setTasks(data.tasks);
    } catch (e) {
      console.error("Failed to fetch tasks", e);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const addTask = async (task: Omit<TimeTask, 'id' | 'next_run_time' | 'triggered'>) => {
    try {
      await fetch(`${BASE_URL}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(task)
      });
      await fetchTasks();
    } catch (e) {
      console.error("Failed to add task", e);
    }
  };

  const deleteTask = async (id: number) => {
    try {
      await fetch(`${BASE_URL}/tasks/${id}`, { method: 'DELETE' });
      await fetchTasks();
    } catch (e) {
      console.error("Failed to delete task", e);
    }
  };

  return { tasks, isLoading, fetchTasks, addTask, deleteTask };
}