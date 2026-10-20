import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import { lazy, StrictMode, Suspense, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useParams } from 'react-router';
import { Layout, NotFound } from './components/Layout';
import { ToastProvider } from './components/ui';
import { AuthProvider, RequireAuth } from './lib/auth';
import { LoginPage, SignupPage } from './pages/Auth';
import { LandingPage } from './pages/Landing';
import './styles.css';

/** Route-level code splitting: the landing and sign-in pages load first; the console loads on demand. */
function page(load: () => Promise<object>, name: string) {
  const C = lazy(() => load().then((m) => ({ default: (m as Record<string, ComponentType>)[name]! })));
  return <C />;
}

function Fallback() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center" role="status" aria-label="Loading">
      <div className="size-6 animate-spin rounded-full border-2 border-border-strong border-t-accent" />
    </div>
  );
}

function Lazy() {
  return (
    <Suspense fallback={<Fallback />}>
      <Outlet />
    </Suspense>
  );
}

function LegacyExecution() {
  const { id } = useParams();
  return <Navigate to={`/app/executions/${id}`} replace />;
}

const router = createBrowserRouter([
  { path: '/', element: <LandingPage /> },
  { path: '/login', element: <LoginPage /> },
  { path: '/signup', element: <SignupPage /> },
  {
    element: <Lazy />,
    children: [
      { path: '/forgot-password', element: page(() => import('./pages/Recover'), 'ForgotPasswordPage') },
      { path: '/reset-password', element: page(() => import('./pages/Recover'), 'ResetPasswordPage') },
      { path: '/invite/:token', element: page(() => import('./pages/Recover'), 'InvitePage') },
      {
        path: '/onboarding',
        element: <RequireAuth>{page(() => import('./pages/Onboarding'), 'OnboardingPage')}</RequireAuth>,
      },
    ],
  },
  {
    path: '/app',
    element: (
      <RequireAuth>
        <Layout />
      </RequireAuth>
    ),
    children: [
      {
        element: <Lazy />,
        children: [
          { index: true, element: page(() => import('./pages/Overview'), 'OverviewPage') },
          { path: 'demo', element: page(() => import('./pages/Demo'), 'DemoPage') },
          { path: 'executions', element: page(() => import('./pages/Executions'), 'ExecutionsPage') },
          { path: 'executions/:id', element: page(() => import('./pages/Execution'), 'ExecutionPage') },
          { path: 'recovery', element: page(() => import('./pages/Recovery'), 'RecoveryPage') },
          { path: 'adapters', element: page(() => import('./pages/Adapters'), 'AdaptersPage') },
          { path: 'policies', element: page(() => import('./pages/Policies'), 'PoliciesPage') },
          { path: 'audit', element: page(() => import('./pages/Audit'), 'AuditPage') },
          {
            path: 'settings',
            element: page(() => import('./pages/settings/SettingsLayout'), 'SettingsLayout'),
            children: [
              { index: true, element: page(() => import('./pages/settings/General'), 'GeneralSettings') },
              { path: 'members', element: page(() => import('./pages/settings/Members'), 'MembersSettings') },
              { path: 'keys', element: page(() => import('./pages/settings/Keys'), 'KeysSettings') },
              { path: 'webhooks', element: page(() => import('./pages/settings/Webhooks'), 'WebhooksSettings') },
              { path: 'connect', element: page(() => import('./pages/settings/Connect'), 'ConnectSettings') },
              { path: 'account', element: page(() => import('./pages/settings/Account'), 'AccountSettings') },
            ],
          },
          { path: '*', element: <NotFound /> },
        ],
      },
    ],
  },
  { path: '/demo', element: <Navigate to="/app/demo" replace /> },
  { path: '/executions', element: <Navigate to="/app/executions" replace /> },
  { path: '/executions/:id', element: <LegacyExecution /> },
  { path: '/connect', element: <Navigate to="/app/settings/connect" replace /> },
  { path: '*', element: <NotFound /> },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </ToastProvider>
  </StrictMode>,
);
