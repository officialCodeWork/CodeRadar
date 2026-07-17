// Pages-router: getStaticProps fetches at build time; feeds the page.
export async function getStaticProps() {
  const res = await fetch("/api/posts");
  const posts = await res.json();
  return { props: { posts } };
}

export default function BlogPage({ posts }: { posts: { id: string }[] }) {
  return (
    <main>
      <h1>Blog index</h1>
      <span>{posts.length} posts</span>
    </main>
  );
}
