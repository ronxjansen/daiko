import { Link, Outlet, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { Dashboard } from './pages/Dashboard'
import { Projects } from './pages/Projects'
import { ProjectDetail } from './pages/ProjectDetail'
import { ArtifactList } from './pages/ArtifactList'
import { ArtifactDetail } from './pages/ArtifactDetail'
import { Sessions } from './pages/Sessions'
import { SessionDetail } from './pages/SessionDetail'

function Layout() {
  return (
    <div className="app">
      <aside className="sidebar">
        <Link to="/" className="wordmark">
          <span className="wordmark-badge">D</span>
          <span>Daiko</span>
        </Link>
        <nav className="sidenav">
          <Link to="/" activeOptions={{ exact: true }} activeProps={{ className: 'active' }}>
            Dashboard
          </Link>
          <Link to="/projects" activeProps={{ className: 'active' }}>
            Projects
          </Link>
          <Link to="/skills" activeProps={{ className: 'active' }}>
            Skills
          </Link>
          <Link to="/mcp" activeProps={{ className: 'active' }}>
            <span className="nav-full">MCP Servers</span>
            <span className="nav-short">MCP</span>
          </Link>
          <Link to="/sessions" activeProps={{ className: 'active' }}>
            Sessions
          </Link>
        </nav>
      </aside>
      <main className="content">
        <Outlet />
      </main>
    </div>
  )
}

const rootRoute = createRootRoute({ component: Layout })

const dashboardRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: Dashboard })
const projectsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/projects', component: Projects })
const projectDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$projectId',
  component: ProjectDetail,
})
const skillsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/skills',
  component: () => <ArtifactList type="skill" title="Skills" />,
})
const mcpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mcp',
  component: () => <ArtifactList type="mcp_server" title="MCP Servers" />,
})
const artifactDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/artifacts/$artifactId',
  component: ArtifactDetail,
})
const sessionsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/sessions', component: Sessions })
const sessionDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sessions/$sessionId',
  component: SessionDetail,
})

const routeTree = rootRoute.addChildren([
  dashboardRoute,
  projectsRoute,
  projectDetailRoute,
  skillsRoute,
  mcpRoute,
  artifactDetailRoute,
  sessionsRoute,
  sessionDetailRoute,
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
