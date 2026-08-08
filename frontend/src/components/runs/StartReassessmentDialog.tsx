'use client'

import { FormEvent, useEffect, useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Icons } from '@/components/ui/icons'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  EMPTY_START_VALUES,
  REASON_CODE_OPTIONS,
  isStartRunValid,
} from '@/lib/runs'
import type { StartRunValues } from '@/lib/runs'

const NO_REASON = 'no-reason'

export type StartReassessmentDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Only Admin and People Ops may reassess a whole cohort. */
  canChooseCohort: boolean
  employeeSuggestions: string[]
  submitting: boolean
  message: string | null
  /** When these exact details were already sent, the time they were sent. */
  alreadySentAt: (values: StartRunValues) => string | null
  onSubmit: (values: StartRunValues, startSeparate: boolean) => void
}

export function StartReassessmentDialog({
  open,
  onOpenChange,
  canChooseCohort,
  employeeSuggestions,
  submitting,
  message,
  alreadySentAt,
  onSubmit,
}: StartReassessmentDialogProps) {
  const [values, setValues] = useState<StartRunValues>(EMPTY_START_VALUES)
  const fieldId = useId()
  const listId = `${fieldId}-employees`

  // Reopening the dialog always starts from a clean form so a stale employee
  // id from an earlier request cannot be submitted by accident.
  useEffect(() => {
    if (open) setValues(EMPTY_START_VALUES)
  }, [open])

  const valid = isStartRunValid(values)
  const duplicateAt = valid ? alreadySentAt(values) : null

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!valid || submitting) return
    onSubmit(values, false)
  }

  // Switching scope clears the field that no longer applies, so the request can
  // never carry both an employee and a cohort.
  const chooseScope = (scope: StartRunValues['scope']) => {
    setValues((current) => ({
      ...current,
      scope,
      employeeId: scope === 'employee' ? current.employeeId : '',
      cohort: scope === 'cohort' ? current.cohort : '',
    }))
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent className='max-h-[calc(100dvh-8rem)] overflow-y-auto sm:max-w-xl'>
        <DialogHeader>
          <DialogTitle>Start a reassessment</DialogTitle>
          <DialogDescription>
            The governed onboarding and retention checks run again against the
            current policy. Anything they find is added to the Workbench for a
            person to review.
          </DialogDescription>
        </DialogHeader>

        <form className='space-y-5' onSubmit={submit}>
          {canChooseCohort ? (
            <fieldset className='space-y-2' disabled={submitting}>
              <legend className='text-sm font-medium'>Who to reassess</legend>
              <div className='grid gap-2 sm:grid-cols-2'>
                {(
                  [
                    {
                      scope: 'employee' as const,
                      title: 'One employee',
                      hint: 'Reassess a single person.',
                      icon: Icons.user,
                    },
                    {
                      scope: 'cohort' as const,
                      title: 'One cohort',
                      hint: 'Reassess everyone in a starting group.',
                      icon: Icons.users,
                    },
                  ] as const
                ).map((option) => {
                  const selected = values.scope === option.scope
                  return (
                    <label
                      key={option.scope}
                      className={`flex cursor-pointer gap-3 rounded-lg border p-3 transition ${
                        selected
                          ? 'border-brand-cornflower bg-brand-cornflower/5'
                          : 'border-border hover:border-brand-cornflower/40'
                      } focus-within:ring-2 focus-within:ring-brand-cornflower/50`}
                    >
                      <input
                        type='radio'
                        name={`${fieldId}-scope`}
                        className='sr-only'
                        value={option.scope}
                        checked={selected}
                        onChange={() => chooseScope(option.scope)}
                      />
                      <option.icon
                        aria-hidden='true'
                        className={`mt-0.5 h-5 w-5 shrink-0 ${
                          selected
                            ? 'text-brand-cornflower'
                            : 'text-muted-foreground'
                        }`}
                      />
                      <span className='min-w-0'>
                        <span className='block text-sm font-medium text-foreground'>
                          {option.title}
                        </span>
                        <span className='block text-xs text-muted-foreground'>
                          {option.hint}
                        </span>
                      </span>
                    </label>
                  )
                })}
              </div>
            </fieldset>
          ) : (
            <p className='rounded-lg border border-brand-cornflower/30 bg-brand-cornflower/5 p-3 text-sm text-muted-foreground'>
              Your access covers your own direct reports, so a reassessment
              started here always covers one person.
            </p>
          )}

          {values.scope === 'employee' ? (
            <div className='space-y-2'>
              <Label htmlFor={`${fieldId}-employee`}>Employee ID</Label>
              <Input
                id={`${fieldId}-employee`}
                value={values.employeeId}
                list={employeeSuggestions.length > 0 ? listId : undefined}
                autoComplete='off'
                disabled={submitting}
                placeholder='For example EMP7021'
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    employeeId: event.target.value,
                  }))
                }
                aria-describedby={`${fieldId}-employee-hint`}
              />
              {employeeSuggestions.length > 0 && (
                <datalist id={listId}>
                  {employeeSuggestions.map((suggestion) => (
                    <option key={suggestion} value={suggestion} />
                  ))}
                </datalist>
              )}
              <p
                id={`${fieldId}-employee-hint`}
                className='text-xs text-muted-foreground'
              >
                {employeeSuggestions.length > 0
                  ? 'Start typing to pick from the people who currently have a case, or enter any employee ID you are allowed to review.'
                  : 'Enter the employee ID exactly as it appears in the HR records.'}
              </p>
            </div>
          ) : (
            <div className='space-y-2'>
              <Label htmlFor={`${fieldId}-cohort`}>Cohort name</Label>
              <Input
                id={`${fieldId}-cohort`}
                value={values.cohort}
                autoComplete='off'
                disabled={submitting}
                placeholder='For example 2026-08-JAKARTA'
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    cohort: event.target.value,
                  }))
                }
                aria-describedby={`${fieldId}-cohort-hint`}
              />
              <p
                id={`${fieldId}-cohort-hint`}
                className='text-xs text-muted-foreground'
              >
                Enter the cohort name exactly as it appears in the HR records.
                Every person in it is reassessed.
              </p>
            </div>
          )}

          <div className='space-y-2'>
            <Label htmlFor={`${fieldId}-reason`}>Reason (optional)</Label>
            <Select
              value={values.reasonCode ?? NO_REASON}
              disabled={submitting}
              onValueChange={(next) =>
                setValues((current) => ({
                  ...current,
                  reasonCode: next === NO_REASON ? null : next,
                }))
              }
            >
              <SelectTrigger id={`${fieldId}-reason`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_REASON}>No specific reason</SelectItem>
                {REASON_CODE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className='text-xs text-muted-foreground'>
              Recorded with the reassessment so the audit trail shows why it was
              asked for.
            </p>
          </div>

          {duplicateAt && (
            <div className='space-y-2 rounded-lg border border-amber-300/60 bg-amber-50 p-3 text-sm text-amber-900'>
              <p>
                A reassessment with exactly these details was already started at{' '}
                {duplicateAt}. Submitting again opens that one instead of
                starting a second.
              </p>
              <Button
                type='button'
                size='sm'
                variant='outline'
                disabled={submitting}
                onClick={() => onSubmit(values, true)}
              >
                Start a separate reassessment
              </Button>
            </div>
          )}

          {message && (
            <div
              role='alert'
              className='rounded-lg border border-destructive/30 bg-red-50 p-3 text-sm text-destructive'
            >
              {message}
            </div>
          )}

          <DialogFooter className='gap-2 sm:space-x-0'>
            <Button
              type='button'
              variant='outline'
              disabled={submitting}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type='submit' variant='gradient' disabled={!valid || submitting}>
              <span className='inline-flex h-4 w-4 items-center justify-center'>
                {submitting ? (
                  <Icons.loader className='h-4 w-4 animate-spin' />
                ) : (
                  <Icons.zap className='h-4 w-4' />
                )}
              </span>
              {/* The label never changes, so the button keeps its width and
                  nothing on the form moves while the request is in flight. */}
              Start reassessment
              <span className='sr-only' aria-live='polite'>
                {submitting ? 'Starting the reassessment' : ''}
              </span>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
