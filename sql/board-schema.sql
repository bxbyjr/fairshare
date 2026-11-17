-- Board: one feed per group for events, offers, asks and notices.
-- Run once in the Supabase SQL Editor. Additive only; touches nothing else.

create table if not exists public.group_posts (
  id          uuid primary key default gen_random_uuid(),
  group_id    uuid not null references public.groups(id) on delete cascade,
  author_id   uuid not null references public.profiles(id) on delete cascade,
  kind        text not null check (kind in ('event','offer','ask','notice')),
  title       text not null check (char_length(title) between 1 and 120),
  detail      text check (char_length(detail) <= 1000),
  price       numeric(12,2) check (price is null or price >= 0),   -- group credits; null = not for sale
  place_name  text,
  lat         double precision,
  lng         double precision,
  starts_at   timestamptz,          -- events
  ends_at     timestamptz,          -- events
  image_url   text,                 -- optional cover photo (storage public URL)
  status      text not null default 'open' check (status in ('open','done','removed')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.group_posts add column if not exists image_url text;
create index if not exists group_posts_group_idx on public.group_posts (group_id, status, created_at desc);

create table if not exists public.post_responses (
  post_id    uuid not null references public.group_posts(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

alter table public.group_posts enable row level security;
alter table public.post_responses enable row level security;

drop policy if exists "members read posts" on public.group_posts;
create policy "members read posts" on public.group_posts
  for select using (public.is_group_member(group_id));
drop policy if exists "members create posts" on public.group_posts;
create policy "members create posts" on public.group_posts
  for insert with check (author_id = auth.uid() and public.is_group_member(group_id));
drop policy if exists "authors edit posts" on public.group_posts;
create policy "authors edit posts" on public.group_posts
  for update using (author_id = auth.uid()) with check (author_id = auth.uid());

drop policy if exists "members read responses" on public.post_responses;
create policy "members read responses" on public.post_responses
  for select using (exists (select 1 from public.group_posts p where p.id = post_id and public.is_group_member(p.group_id)));
drop policy if exists "members respond" on public.post_responses;
create policy "members respond" on public.post_responses
  for insert with check (user_id = auth.uid() and exists (select 1 from public.group_posts p where p.id = post_id and public.is_group_member(p.group_id)));
drop policy if exists "members unrespond" on public.post_responses;
create policy "members unrespond" on public.post_responses
  for delete using (user_id = auth.uid());

-- One call returns the board for a group: posts, author, responders, whether I'm in.
create or replace function public.list_board(p_group_id uuid)
returns table (
  id uuid, kind text, title text, detail text, price numeric, place_name text, lat double precision, lng double precision,
  starts_at timestamptz, ends_at timestamptz, status text, created_at timestamptz, image_url text,
  author_id uuid, author_name text, author_image text,
  responders jsonb, i_responded boolean
) language sql security definer stable as $$
  select p.id, p.kind, p.title, p.detail, p.price, p.place_name, p.lat, p.lng, p.starts_at, p.ends_at, p.status, p.created_at, p.image_url,
         p.author_id, coalesce(a.display_name, 'Member'), a.profile_image_url,
         coalesce((select jsonb_agg(jsonb_build_object('id', r.user_id, 'name', coalesce(rp.display_name,'Member'), 'image', rp.profile_image_url) order by r.created_at)
                   from public.post_responses r join public.profiles rp on rp.id = r.user_id where r.post_id = p.id), '[]'::jsonb),
         exists (select 1 from public.post_responses r where r.post_id = p.id and r.user_id = auth.uid())
  from public.group_posts p
  join public.profiles a on a.id = p.author_id
  where p.group_id = p_group_id and p.status <> 'removed' and public.is_group_member(p_group_id)
  order by p.created_at desc;
$$;
grant execute on function public.list_board(uuid) to authenticated;

-- Tell the group when something is posted (reuses the existing push + event feed).
create or replace function public.board_post_notify()
returns trigger language plpgsql security definer as $$
declare v_name text; v_label text;
begin
  select coalesce(display_name,'Someone') into v_name from public.profiles where id = new.author_id;
  v_label := case new.kind when 'event' then 'is hosting' when 'offer' then 'is offering' when 'ask' then 'is asking for' else 'posted' end;
  insert into public.group_events (group_id, event_type, summary, actor_id, metadata)
  values (new.group_id, 'board_post', v_name || ' ' || v_label || ': ' || new.title, new.author_id, jsonb_build_object('post_id', new.id, 'kind', new.kind));
  begin
    perform public.send_push_to_group(new.group_id, new.author_id, v_name || ' ' || v_label, new.title, '/', false);
  exception when others then null;
  end;
  return new;
end $$;
drop trigger if exists board_post_notify on public.group_posts;
create trigger board_post_notify after insert on public.group_posts for each row execute function public.board_post_notify();

-- Tell the author when someone responds.
create or replace function public.board_response_notify()
returns trigger language plpgsql security definer as $$
declare v_post public.group_posts; v_name text; v_verb text;
begin
  select * into v_post from public.group_posts where id = new.post_id;
  if v_post.author_id = new.user_id then return new; end if;
  select coalesce(display_name,'Someone') into v_name from public.profiles where id = new.user_id;
  v_verb := case v_post.kind when 'event' then 'is going to' when 'ask' then 'can help with' else 'wants' end;
  begin
    perform public.send_push_to_users(array[v_post.author_id], new.user_id, v_name || ' ' || v_verb, v_post.title, '/');
  exception when others then null;
  end;
  return new;
end $$;
drop trigger if exists board_response_notify on public.post_responses;
create trigger board_response_notify after insert on public.post_responses for each row execute function public.board_response_notify();
