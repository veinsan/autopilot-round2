import * as React from 'react'
import {
  LayoutDashboard,
  Settings,
  BotMessageSquare,
  LogOut,
  Bell,
  Search,
  TrendingUp,
  Users,
  User,
  UserPlus,
  UserMinus,
  Activity,
  Palette,
  CheckCircle2,
  ArrowRight,
  ArrowLeft,
  ArrowUp,
  Loader2,
  X,
  Menu,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Sun,
  Moon,
  Command,
  Plus,
  PlusCircle,
  Minus,
  Check,
  AlertCircle,
  AlertTriangle,
  Info,
  HelpCircle,
  ExternalLink,
  Copy,
  Trash2,
  Edit,
  Pencil,
  Eye,
  EyeOff,
  Home,
  FileText,
  Folder,
  FolderOpen,
  Zap,
  Sparkles,
  RefreshCw,
  MoreHorizontal,
  MoreVertical,
  PanelLeftClose,
  PanelLeftOpen,
  Clock,
  Calendar,
  Mail,
  Send,
  Inbox,
  Archive,
  Star,
  Heart,
  Bookmark,
  Share2,
  Download,
  Upload,
  Circle,
  Shield,
  Key,
  Lock,
  Unlock,
  Network,
  MonitorSmartphone,
  Globe,
  Brain,
  Lightbulb,
  MessageSquare,
  MessageCircle,
  Bot,
  Layers,
  Grid3X3,
  Table2,
  ListFilter,
  Building2,
  BarChart3,
  GripVertical,
  Repeat,
  Flag,
  type LucideIcon,
  type LucideProps,
} from 'lucide-react'

export type Icon = LucideIcon

/**
 * The design system asks for thin strokes on every icon. Applying it here means
 * a screen never mixes stroke weights, and a caller that genuinely needs a
 * heavier stroke can still pass its own `strokeWidth`.
 */
function brandStroke(IconComponent: LucideIcon): LucideIcon {
  const Branded = React.forwardRef<SVGSVGElement, LucideProps>(
    (props, ref) => <IconComponent ref={ref} strokeWidth={1.5} {...props} />
  )
  Branded.displayName = `Brand(${IconComponent.displayName ?? 'Icon'})`
  return Branded as unknown as LucideIcon
}

const lucideIcons = {
  // Navigation
  dashboard: LayoutDashboard,
  settings: Settings,
  workbench: BotMessageSquare,
  home: Home,

  // Actions
  logout: LogOut,
  search: Search,
  arrowRight: ArrowRight,
  arrowLeft: ArrowLeft,
  arrowUp: ArrowUp,
  externalLink: ExternalLink,
  copy: Copy,
  trash: Trash2,
  edit: Edit,
  pencil: Pencil,
  refresh: RefreshCw,
  download: Download,
  upload: Upload,
  send: Send,
  share: Share2,

  // UI Controls
  loader: Loader2,
  close: X,
  menu: Menu,
  chevronLeft: ChevronLeft,
  chevronRight: ChevronRight,
  chevronDown: ChevronDown,
  chevronUp: ChevronUp,
  plus: Plus,
  plusCircle: PlusCircle,
  minus: Minus,
  moreHorizontal: MoreHorizontal,
  moreVertical: MoreVertical,
  panelClose: PanelLeftClose,
  panelOpen: PanelLeftOpen,

  // Theme
  sun: Sun,
  moon: Moon,

  // Keyboard
  command: Command,

  // Status & Feedback
  check: Check,
  checkCircle: CheckCircle2,
  alertCircle: AlertCircle,
  alertTriangle: AlertTriangle,
  info: Info,
  helpCircle: HelpCircle,
  help: HelpCircle,

  // Visibility
  eye: Eye,
  eyeOff: EyeOff,

  // Data & Stats
  trendingUp: TrendingUp,
  users: Users,
  user: User,
  userPlus: UserPlus,
  userMinus: UserMinus,
  activity: Activity,

  // Notifications
  bell: Bell,
  inbox: Inbox,
  mail: Mail,
  archive: Archive,

  // Time
  clock: Clock,
  calendar: Calendar,

  // Files
  fileText: FileText,
  folder: Folder,
  folderOpen: FolderOpen,

  // Special
  zap: Zap,
  sparkles: Sparkles,
  star: Star,
  heart: Heart,
  bookmark: Bookmark,
  palette: Palette,

  // Shapes
  circle: Circle,

  // Security
  shield: Shield,
  key: Key,
  lock: Lock,
  unlock: Unlock,

  // Network & Sessions
  network: Network,
  device: MonitorSmartphone,
  globe: Globe,

  // AI Features
  brain: Brain,
  lightbulb: Lightbulb,
  messageSquare: MessageSquare,
  messageCircle: MessageCircle,
  bot: Bot,
  layers: Layers,
  grid: Grid3X3,
  table: Table2,
  table2: Table2,
  filter: ListFilter,
  listFilter: ListFilter,
  building: Building2,
  barChart: BarChart3,
  
  // Drag & Drop
  gripVertical: GripVertical,
  
  // Misc
  repeat: Repeat,
  flag: Flag,
} as const

export const Icons = Object.fromEntries(
  Object.entries(lucideIcons).map(([name, IconComponent]) => [
    name,
    brandStroke(IconComponent),
  ])
) as Record<keyof typeof lucideIcons, LucideIcon>
