import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import type {User} from '../../shared/types.js';
import {ApiError, api} from './api.js';

export const ME_KEY = ['me'] as const;

export interface Credentials {
  email: string;
  password: string;
}

/** Resolves to `null` rather than throwing when there is no session. */
async function fetchMe(): Promise<User | null> {
  try {
    return await api.get<User>('/api/me');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

export function useMe() {
  return useQuery({queryKey: ME_KEY, queryFn: fetchMe, retry: false, staleTime: 30_000});
}

export function useLogin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (credentials: Credentials) => api.post<User>('/api/auth/login', credentials),
    onSuccess: user => client.setQueryData(ME_KEY, user),
  });
}

export function useRegister() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (credentials: Credentials) => api.post<User>('/api/auth/register', credentials),
    onSuccess: user => client.setQueryData(ME_KEY, user),
  });
}

export function useLogout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<void>('/api/auth/logout'),
    onSuccess: () => {
      client.setQueryData(ME_KEY, null);
      // Drop everything the previous session loaded, but keep the `me` entry we just set
      // so the app switches to sign-in without a round trip.
      client.removeQueries({predicate: query => query.queryKey[0] !== ME_KEY[0]});
    },
  });
}
